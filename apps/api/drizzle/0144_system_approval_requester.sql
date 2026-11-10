-- Custom SQL migration file, put your code below! ---
-- legend-2dnh: a refund the system creates (POS or QR late payment,
-- reservation deposit) opens its approval chain at creation, but
-- approval_requests.requested_by is a NOT NULL foreign key to "user". Give the
-- chain a reserved requester: banned, no account row (it cannot sign in), no
-- role and no assignment (it cannot decide, and the decided_by <> requested_by
-- check keeps it out of every chain it opened). The id is SYSTEM_ACCOUNT_ID in
-- src/lib/system-account.ts.
--
-- The email carries a random part, so it can never collide with an address a
-- person signed up with (email is unique). A row that already holds the id is
-- never adopted: the check below fails the migration unless that row is this
-- system account (name, email pattern, banned, no role, no sign-in account).
-- role_assignments is not read here: it forces row level security and the
-- migration has no tenant context. The trigger below keeps the id out of it.
INSERT INTO "user" (id, name, email, email_verified, banned, ban_reason, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'Sistem',
  'system-approval-' || gen_random_uuid()::text || '@legend.invalid',
  false,
  true,
  'system account',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "user"
    WHERE id = '00000000-0000-4000-8000-000000000002'
      AND name = 'Sistem'
      AND email LIKE 'system-approval-%@legend.invalid'
      AND banned = true AND ban_expires IS NULL AND role IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "account" WHERE user_id = '00000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'legend-2dnh: user 00000000-0000-4000-8000-000000000002 is not the reserved system account (banned, no role, no sign-in account)';
  END IF;
END $$;
--> statement-breakpoint
-- Every path that creates or changes "user" (Better Auth admin create-user,
-- unban, set-role, the role:set CLI, any service, raw SQL): the system account
-- stays banned with no role and no ban expiry, and an account under an active
-- ban (banned, no expiry or an expiry still ahead, as Better Auth reads it) is
-- never created with, or given, a global role. On UPDATE an unchanged role is
-- left alone, so banning an account that already has a role still works.
CREATE OR REPLACE FUNCTION legend_user_role_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = '00000000-0000-4000-8000-000000000002'
     AND (NEW.banned IS NOT TRUE OR NEW.ban_expires IS NOT NULL OR NEW.role IS NOT NULL) THEN
    RAISE EXCEPTION 'the reserved system account stays banned with no role'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.banned IS TRUE AND (NEW.ban_expires IS NULL OR NEW.ban_expires > now())
     AND NEW.role IS NOT NULL THEN
    -- OLD is only read on UPDATE (it is not assigned on INSERT).
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'a banned account cannot be given a role'
        USING ERRCODE = 'check_violation';
    ELSIF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'a banned account cannot be given a role'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER user_role_guard BEFORE INSERT OR UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION legend_user_role_guard();
--> statement-breakpoint
-- Every path that grants or widens a tenant role (grantRoleAssignment, tenant
-- provisioning, direct SQL): never for the system account or an account under
-- an active ban. A ban placed after the grant keeps the assignment as it is,
-- and it can still be revoked: an UPDATE that only ends or shortens it (a
-- valid_until that is set, earlier, or unchanged; a valid_from that is unchanged
-- or later; same user, tenant, role and scope) is allowed. Any other change
-- (role, scope, tenant, an earlier start, a later or removed end) is refused.
CREATE OR REPLACE FUNCTION legend_role_assignment_grantee_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    NEW.user_id = '00000000-0000-4000-8000-000000000002'
    OR EXISTS (
      SELECT 1 FROM "user" WHERE id = NEW.user_id AND banned IS TRUE
        AND (ban_expires IS NULL OR ban_expires > now())
    )
  ) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id = OLD.user_id
       AND NEW.tenant_id = OLD.tenant_id
       AND NEW.role_id = OLD.role_id
       AND NEW.scope_type = OLD.scope_type
       AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id
       AND NEW.valid_from >= OLD.valid_from
       AND (
         NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until
         OR (NEW.valid_until IS NOT NULL
             AND (OLD.valid_until IS NULL OR NEW.valid_until <= OLD.valid_until))
       ) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a banned or system account cannot be given a role'
    USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER role_assignments_grantee_guard BEFORE INSERT OR UPDATE ON "role_assignments"
FOR EACH ROW EXECUTE FUNCTION legend_role_assignment_grantee_guard();
