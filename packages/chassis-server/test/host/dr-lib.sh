# shellcheck shell=bash
# The chassis test host's copy of the disaster-recovery shell library every tool
# ships as scripts/lib/dr-lib.sh (the tool template's, byte for byte below this
# header). The chassis suite's dump check (test/integration/dr-verify-real-dump.test.ts)
# sources the library its HOST names: a tool names its own, this host names this file.
# shellcheck shell=bash
# Disaster-recovery helpers shared by backup.sh, restore.sh and update.sh.
#
# Everything here is a pure function over files: no docker, no network, no
# destructive side effect. That is deliberate — it is the part of the DR path
# that MUST be tested, and it is testable only if it can run against fixture
# files on a laptop (test/unit/dr-lib.test.ts drives exactly these entry
# points, including a deliberately truncated dump).
#
# Source it with:
#   . "$(cd "$(dirname "$0")" && pwd)/lib/dr-lib.sh"

dr_info() { printf '\033[0;34m▸ %s\033[0m\n' "$*"; }
dr_success() { printf '\033[0;32m✔ %s\033[0m\n' "$*"; }
dr_warn() { printf '\033[0;33m! %s\033[0m\n' "$*" >&2; }
dr_fail() {
  printf '\033[0;31m✖ %s\033[0m\n' "$*" >&2
  exit 1
}

# ── archive verification ────────────────────────────────────────────────────

# dr_verify_gzip FILE — the file exists, is non-empty and is an intact gzip
# stream. Catches the common truncation (a dump cut off mid-transfer).
dr_verify_gzip() {
  local file="$1"
  [ -f "$file" ] || dr_fail "missing archive: $file"
  [ -s "$file" ] || dr_fail "empty archive: $file"
  gzip -t "$file" 2>/dev/null || dr_fail "corrupt gzip stream: $file"
}

# dr_verify_tar FILE — intact gzip AND a listable tar holding at least one
# entry. An empty-but-valid tarball would silently wipe /data on restore.
dr_verify_tar() {
  local file="$1" entries
  dr_verify_gzip "$file"
  # No `| head`: under `set -o pipefail` an early-closed pipe would mask the
  # tar exit status. Listing is metadata-only, so reading it all is cheap.
  entries=$(tar -tzf "$file" 2>/dev/null | wc -l | tr -d ' ') ||
    dr_fail "not a readable tar archive: $file"
  [ "${entries:-0}" -gt 0 ] || dr_fail "tar archive is empty: $file"
}

# dr_tar_has_entry FILE NAME — NAME (a literal top-level entry, no globs) is
# present in the tarball. backup.sh archives /data as `tar -C /data .`, so the
# entries read `./secret`, `./files/…`; both spellings are accepted.
#
# Needed because the auth secret is only SOMETIMES in the .env: with
# AUTH_SECRET unset the server generates one into $DATA_DIR/secret
# (apps/server/src/secret.ts) and the data volume becomes the pepper root.
# restore.sh has to know which of the two it is holding, and it has to know
# BEFORE it destroys anything.
dr_tar_has_entry() {
  local file="$1" name="$2"
  # No `grep -q`: it exits at the first match, tar then dies of SIGPIPE (141),
  # and under `pipefail` a file that IS in the archive reads as missing.
  tar -tzf "$file" 2>/dev/null | grep -Fx -e "./$name" -e "$name" >/dev/null
}

# dr_verify_pg_dump FILE
#
# Structural verification of a gzipped plain-text pg_dump, PLUS the expected
# row counts extracted from the dump itself. Prints one `<table>\t<rows>` line
# per COPY block on stdout; diagnostics go to stderr.
#
# A gzip-level check is not enough: `pg_dump | gzip > f` can produce a
# perfectly valid gzip stream around a dump that pg_dump never finished
# writing (killed mid-COPY, disk full). psql then replays the partial dump
# happily. The three content checks below are what make a truncated dump
# fail LOUDLY instead of restoring 40% of the rows:
#   1. the pg_dump banner is present (this is a plain-text dump at all),
#   2. every COPY block is terminated by its `\.` marker,
#   3. the "dump complete" trailer pg_dump writes last is present.
dr_verify_pg_dump() {
  local file="$1"
  dr_verify_gzip "$file"
  gunzip -c "$file" | awk '
    # A COPY header only counts OUTSIDE a data block: a text column could
    # legitimately contain a line that looks like one.
    !incopy && /^COPY .* FROM stdin;$/ { tbl = $2; rows = 0; incopy = 1; next }
    incopy && $0 == "\\." { printf "%s\t%d\n", tbl, rows; incopy = 0; next }
    incopy { rows++; next }
    /^-- PostgreSQL database dump$/ { banner = 1 }
    /^-- PostgreSQL database dump complete$/ { complete = 1 }
    END {
      if (!banner) {
        print "not a plain-text pg_dump (banner missing)" > "/dev/stderr"
        exit 1
      }
      if (incopy) {
        printf "TRUNCATED dump: COPY block for %s is never terminated\n", tbl > "/dev/stderr"
        exit 1
      }
      if (!complete) {
        print "TRUNCATED dump: the pg_dump completion trailer is missing" > "/dev/stderr"
        exit 1
      }
    }
  ' || dr_fail "refusing to restore $file"
}

# ── setup transport ─────────────────────────────────────────────────────────

# dr_origin_is_secure URL — true when POST /api/v1/setup will be ACCEPTED over
# this origin: https anywhere, or plaintext on loopback.
#
# This is the shell twin of isSecureSetupOrigin() in
# apps/server/src/setup-transport.ts, and the two MUST agree. The server is
# what enforces the rule; this exists so setup.sh can tell the operator up
# front instead of letting them discover it as a 403 from the wizard. A
# hand-rolled `case` on the URL prefix drifted immediately — it accepted
# `http://localhost.evil.test` as loopback — so the parse is done properly
# here once, and test/unit/dr-lib.test.ts drives the SAME URL table as
# test/unit/setup-transport.test.ts to keep them in step.
dr_origin_is_secure() {
  local url="$1" host
  case "$url" in
    https://*) return 0 ;;
    http://*) ;;
    *) return 1 ;;
  esac
  host=${url#http://}
  # strip path, query and fragment
  host=${host%%/*}
  host=${host%%\?*}
  host=${host%%#*}
  # strip the port — an IPv6 literal keeps its brackets
  case "$host" in
    \[*\]*) host="${host%%\]*}]" ;;
    *:*) host=${host%%:*} ;;
  esac
  host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
  case "$host" in
    localhost | *.localhost) return 0 ;;
    '[::1]' | '[0:0:0:0:0:0:0:1]') return 0 ;;
  esac
  # 127.0.0.0/8, including the dotted-shorthand forms URL parsers normalise
  # into it (`127.1` IS 127.0.0.1, `127.0.0` IS 127.0.0.0) — the server sees the
  # normalised host, so this has to match what it will conclude. Anchored, so
  # `127.0.0.1.evil.test` and `1270.0.0.1` stay out: those are hostnames
  # somebody else controls.
  if printf '%s' "$host" | grep -Eq '^127(\.[0-9]{1,3}){1,3}$'; then
    return 0
  fi
  return 1
}

# ── .env handling ───────────────────────────────────────────────────────────

# dr_env_get FILE KEY — last assignment of KEY, verbatim (no quote stripping,
# so a value round-trips byte-for-byte). Prints nothing when absent.
dr_env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -v want="$key" '
    /^[[:space:]]*#/ { next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      k = substr($0, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      if (k == want) { val = substr($0, eq + 1); found = 1 }
    }
    END { if (found) print val }
  ' "$file"
}

# dr_env_set FILE KEY VALUE — replace the first assignment of KEY in place
# (dropping any later duplicates), or append it. Written through a temp file
# in the same directory, so the .env is never left half-written; mode stays
# 600.
dr_env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp=$(mktemp "${file}.XXXXXX")
  awk -v want="$key" -v val="$value" '
    {
      eq = index($0, "=")
      if (eq > 0 && $0 !~ /^[[:space:]]*#/) {
        k = substr($0, 1, eq - 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
        if (k == want) {
          if (!done) { print want "=" val; done = 1 }
          next
        }
      }
      print
    }
    END { if (!done) print want "=" val }
  ' "$file" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# dr_env_unset FILE KEY — remove EVERY assignment of KEY. Used to stop a
# freshly generated AUTH_SECRET in the live .env from shadowing the pepper root
# that came back inside the restored data volume: an env value always beats
# $DATA_DIR/secret, so leaving it there is what makes that restore silently
# invalidate every API key.
dr_env_unset() {
  local file="$1" key="$2" tmp
  [ -f "$file" ] || return 0
  tmp=$(mktemp "${file}.XXXXXX")
  awk -v want="$key" '
    {
      eq = index($0, "=")
      if (eq > 0 && $0 !~ /^[[:space:]]*#/) {
        k = substr($0, 1, eq - 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
        if (k == want) next
      }
      print
    }
  ' "$file" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# The ONLY keys restore.sh copies out of a backed-up .env.
#
# AUTH_SECRET is the pepper root: API-key hashes, share-link/edit-secret
# hashes and the idempotency cipher all derive from it. setup.sh generates a
# FRESH one on a clean host, so a restore that brings back the database
# without this value produces an instance where every pre-existing API key and
# share link resolves to nothing — a "successful" restore that silently threw
# away the credentials. API_KEY_PEPPERS carries the same material for
# instances mid-rotation.
#
# Everything else in the archived .env is deliberately NOT copied. The live
# POSTGRES_PASSWORD in particular belongs to the database container running
# on THIS host; overwriting it with the old one locks the app out of its own
# database.
DR_PEPPER_KEYS="AUTH_SECRET API_KEY_PEPPERS"

# dr_merge_pepper_env SRC DST — merge only DR_PEPPER_KEYS from SRC into DST.
# Prints the names of the keys it changed, one per line.
dr_merge_pepper_env() {
  local src="$1" dst="$2" key val cur
  [ -f "$src" ] || dr_fail "missing archived .env: $src"
  [ -f "$dst" ] || dr_fail "missing live .env: $dst"
  for key in $DR_PEPPER_KEYS; do
    val=$(dr_env_get "$src" "$key")
    [ -n "$val" ] || continue
    cur=$(dr_env_get "$dst" "$key")
    [ "$cur" = "$val" ] && continue
    dr_env_set "$dst" "$key" "$val"
    printf '%s\n' "$key"
  done
}
