--# Chassis test fixture (PRDCT-2544). It mirrors the onboarding backfill migration of
--# the product this chassis was extracted from: every line below this header is that
--# migration, byte for byte. The chassis owns this copy, so its suite names no tool
--# migration file; the product keeps a test that the two stay equal.
-- SL-6 backfill: every user existing at deploy is marked already-dismissed —
-- the first-run welcome belongs to users whose FIRST login happens after
-- this ships; nobody gets a retroactive banner. New users get their row
-- (dismissed_at NULL = welcome owed) from the login path's lazy insert.
-- ON CONFLICT keeps the backfill re-runnable and never clobbers a row the
-- login path already wrote.
INSERT INTO "user_onboarding" ("user_id", "first_login_at", "dismissed_at")
SELECT "id", now(), now() FROM "user"
ON CONFLICT ("user_id") DO NOTHING;
