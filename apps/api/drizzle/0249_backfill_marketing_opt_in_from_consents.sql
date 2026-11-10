-- The migrator may be a plain table owner (no SUPERUSER, no BYPASSRLS): FORCE
-- ROW LEVEL SECURITY would then apply the tenant policies to it and, with no
-- app.tenant_id set, raise 42501 on consents and customer_profiles. Lift FORCE
-- for this transaction only and restore it before commit (drizzle applies
-- pending migrations in one transaction), as in 0068, 0116, 0140, 0145 and 0241.
ALTER TABLE public.consents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer_profiles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Backfill (Codex 411, legend-37wom): the staff consent path used to write a
-- consents row without syncing customer_profiles.marketing_opt_in. Set the flag
-- from each profile's latest marketing decision (highest seq). Only profiles
-- with a marketing consent row and a differing flag change.

UPDATE "customer_profiles" AS p
SET "marketing_opt_in" = (latest."decision" = 'granted')
FROM (
  SELECT DISTINCT ON ("tenant_id", "subject_id")
    "tenant_id", "subject_id", "decision"
  FROM "consents"
  WHERE "purpose" = 'marketing'
  ORDER BY "tenant_id", "subject_id", "seq" DESC
) AS latest
WHERE p."tenant_id" = latest."tenant_id"
  AND p."id" = latest."subject_id"
  AND p."marketing_opt_in" IS DISTINCT FROM (latest."decision" = 'granted');
--> statement-breakpoint
ALTER TABLE public.customer_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.consents FORCE ROW LEVEL SECURITY;
