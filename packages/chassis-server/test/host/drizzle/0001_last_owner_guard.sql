-- The last-active-owner guard, the one piece of the chassis's schema that is hand-written SQL:
-- a tool carries the same function and trigger in its own migration history (the tool
-- template's baseline), and the chassis's test host carries it here so its own run holds
-- the same floor the suite pins (last-owner-race.test.ts, the DB-level backstop).
CREATE FUNCTION enforce_last_active_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.role = 'owner' AND NEW.is_active
     AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NEW; -- still an active owner here (e.g. last_seen_at touch)
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspaces
     WHERE id = OLD.workspace_id AND central_account_id IS NOT NULL
  ) THEN
    -- Projected workspace: ownership is hub truth, no local floor to hold.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(7432002, hashtext(OLD.workspace_id::text));
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
     WHERE workspace_id = OLD.workspace_id
       AND role = 'owner' AND is_active AND id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'workspace % must keep at least one active owner', OLD.workspace_id
      USING ERRCODE = 'P0409';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workspace_members_last_owner_guard
BEFORE DELETE OR UPDATE ON workspace_members
FOR EACH ROW
WHEN (OLD.role = 'owner' AND OLD.is_active)
EXECUTE FUNCTION enforce_last_active_owner();
