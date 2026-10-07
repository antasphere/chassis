# The Antasphere chassis (`antasphere/chassis`)

The generic half of every Antasphere tool, five packages under `packages/chassis-*`, published
on npm, public, as `@antasphere/chassis-{db,contract,server,sdk,cli}` at ONE version in lockstep. Every
tool (Slideless, the tool template and every tool instantiated from it) installs them at a pinned
version and never edits them. The code is Slideless's chassis extracted with its history on
7 October 2026 (PRDCT-3268); the invariants below are the ones it carried there, and the Slideless
and tool-template `CLAUDE.md` files remain the long form of each (they name the same files, now
inside this repository).

## Layout

| Path                        | Role                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/chassis-db`       | The generic tables, the generated `auth-schema.ts`, the migration runner (`migrate.ts`, the advisory lock)                                                                                                             |
| `packages/chassis-contract` | The generic zod schemas + route contracts; `src/entitlements.ts` mirrors the hub's wire, `scripts/hub-wire-check.mjs` proves it                                                                                        |
| `packages/chassis-server`   | The generic server: identity, federation, middleware, routers, jobs (pg-boss, the one-off timers), MCP kit; entry `createPlatform(tool)`; `test/integration` is the chassis suite every tool runs against its own host |
| `packages/chassis-sdk`      | The generic typed client (`ChassisClient`)                                                                                                                                                                             |
| `packages/chassis-cli`      | The generic CLI kit: profiles, context, `safe-write.ts`, generic commands; `test/suite` is the CLI suite every tool runs against its own kit                                                                           |
| `scripts/release.mjs`       | The release motion: `pnpm release patch                                                                                                                                                                                | minor | major`, the lookalike-release guard |
| `.github/workflows`         | `ci.yml` (gates, hub wire, integration), `release.yml` (publish on the tag by trusted publishing)                                                                                                                      |

Each package ships `dist/`, `src/` and `test/` (chassis-db: `dist/` and `src/`). The consumers run
`test/integration` and `test/suite` from the installed package against their own host, read
`chassis-db/src/schema.ts` for drizzle and `chassis-db/src/auth-schema.ts` for their drift guard,
so the sources are part of the published surface, not an accident of packaging.

## Invariants — never regress these

- **The chassis never names a tool.** No file here says Slideless, a deck, a brand or any product; the
  tool's identity arrives through `defineChassisContract`, the `identity` slot of the tool definition and
  `cliIdentity`. `git grep -il slideless -- packages` returns nothing. The eslint config refuses an import
  of `@app/*` or `@slideless/*` from any chassis package.
- **One version for the five packages.** `pnpm release` moves the root and the five manifests together;
  CI refuses a package whose version differs from the root; a consumer pins one number for all five.
- **No behaviour change ships without its test**, and the suites a consumer runs (`chassis-server/test/integration`,
  `chassis-cli/test/suite`) import their host from `@chassis-test/host` / `@chassis-cli-test/host`: a new
  suite file that needs something the host does not give declares it on the host type
  (`src/testing`), never reaches around it.
- **The hub owns the wire (PRDCT-2677).** `chassis-contract/src/entitlements.ts` copies the hub's message
  schemas; `pnpm wire:check` compares them with the hub's snapshot (`HUB_WIRE_SNAPSHOT`, else the hub
  checkout four levels up, `labs/products/antasphere/hub`). The hub changes first, the check goes red,
  the chassis follows; never patch the copy to make the check pass.
- **Fail-closed scope allowlist** (`chassis-server/src/middleware/scopes.ts`), **closed sign-up needs three
  switches**, **migrations under a session-scoped advisory lock on a dedicated client**, **the auth
  schema drift guard** (a Better Auth change that alters the schema regenerates `chassis-db/src/auth-schema.ts`
  and every consumer answers with its snapshot and an additive migration), **the CLI writes through
  `safe-write.ts` only**, **a tombstone the boot cannot replay closes the service**, **cloud closes the
  local password-reset surface**, **guest origin is a capability boundary**, **hub-origin workspaces are
  hub-managed**, **a price is a declaration on the route and the chassis names no key**, **the chassis asks
  the hub before a priced action**: unchanged from Slideless's `CLAUDE.md`, which keeps the long form of
  each with the file and the ticket.

## The gates

```bash
pnpm turbo lint typecheck test build --force   # a proof runs with --force: read the Cached line
pnpm format:check
pnpm turbo test:integration --force            # testcontainers; one Postgres per run
pnpm wire:check                                # after pnpm --filter @antasphere/chassis-contract build
```

The chassis packages are consumed through `dist`: rebuild before believing a test that should have
gone red after a source edit.

## A change, end to end

1. A pull request here, on `main`, with its test; CI green (`checks`, `hub-wire`, `integration`).
2. `pnpm release patch|minor|major --title "…" --push` on a clean `main`: the bump commit, the tag, the
   publish by `release.yml`.
3. One version bump per consumer: `pnpm up -r "@antasphere/chassis-*@X.Y.Z"`, the tool's gates, its
   pull request. A bump that changes the auth schema or adds a chassis table also lands the tool's
   snapshot and migration.

Developing a change against a real tool before it is published: build here, then from the tool's root
`pnpm link ../../chassis/packages/chassis-server` (and the siblings you touch); pnpm writes a `link:`
into the tool's `package.json` and lockfile while you work, and `git checkout package.json
pnpm-lock.yaml && pnpm install` puts the registry version back before you commit. The tool's
`pnpm chassis:check` refuses a `link:` that was left behind.

## Public, source-available

The repository and the packages are public under the Sustainable Use License (`LICENSE`, the same
licence as Slideless, licensor Antasphere): say "source-available" or "fair-code", never "open
source". Nothing here may carry a credential, a customer name or an internal hostname: the test
fixtures spell fake values (`integration-test-…`, `pepper-secret-…`), and a sweep of the history
(gitleaks) runs before a visibility change. Every package publishes with `access: public`.

## Secrets on this repository

`FEDERATION_DRILL_APP_ID` / `FEDERATION_DRILL_APP_KEY` (the GitHub App that reads the hub, for `hub-wire`),
`RELEASE_ENABLED=true` (the variable that arms `release.yml`'s publish job). The publish itself is
tokenless (OIDC trusted publishing, configured on npmjs per package); no npm token lives anywhere.
