-- Backfill (Codex 411, legend-37wom): the staff consent path used to write a
-- consents row without syncing customer_profiles.marketing_opt_in. Set the flag
-- from each profile's latest marketing decision (highest seq). Only profiles
-- with a marketing consent row and a differing flag change.
-- NOTE: temporary number; the merge train renumbers.
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
