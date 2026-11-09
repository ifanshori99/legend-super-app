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
-- Every path that changes "user" (Better Auth admin unban / set-role, the
-- role:set CLI, any service): the system account stays banned with no role and
-- no ban expiry, and an account under an active ban (banned, no expiry or an
-- expiry still ahead, as Better Auth reads it) is never given a global role.
CREATE OR REPLACE FUNCTION legend_user_role_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = '00000000-0000-4000-8000-000000000002'
     AND (NEW.banned IS NOT TRUE OR NEW.ban_expires IS NOT NULL OR NEW.role IS NOT NULL) THEN
    RAISE EXCEPTION 'the reserved system account stays banned with no role'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.banned IS TRUE AND (NEW.ban_expires IS NULL OR NEW.ban_expires > now())
     AND NEW.role IS NOT NULL AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'a banned account cannot be given a role'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER user_role_guard BEFORE UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION legend_user_role_guard();
--> statement-breakpoint
-- Every path that grants a tenant role (grantRoleAssignment, tenant
-- provisioning, direct SQL): never to the system account or an account under an
-- active ban. A ban placed after the grant keeps the assignment (unchanged).
CREATE OR REPLACE FUNCTION legend_role_assignment_grantee_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id = '00000000-0000-4000-8000-000000000002'
     OR EXISTS (
       SELECT 1 FROM "user" WHERE id = NEW.user_id AND banned IS TRUE
         AND (ban_expires IS NULL OR ban_expires > now())
     ) THEN
    RAISE EXCEPTION 'a banned or system account cannot be given a role'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER role_assignments_grantee_guard BEFORE INSERT OR UPDATE OF user_id ON "role_assignments"
FOR EACH ROW EXECUTE FUNCTION legend_role_assignment_grantee_guard();
