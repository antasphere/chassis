--# Chassis test fixture (PRDCT-2544). It mirrors the operator user id migration of the
--# product this chassis was extracted from: everything below this header is that
--# migration's part after its first statement breakpoint (the backfill, not the ALTER),
--# byte for byte. The chassis owns this copy, so its suite names no tool migration file;
--# the product keeps a test that the two stay equal.

UPDATE "instance_settings" s
   SET "operator_user_id" = g.owner_id
  FROM (
    SELECT (metadata->>'ownerUserId') AS owner_id
      FROM "audit_log"
     WHERE action = 'instance.setup'
     ORDER BY created_at ASC
     LIMIT 1
  ) g
 WHERE s."operator_user_id" IS NULL
   AND g.owner_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = g.owner_id);