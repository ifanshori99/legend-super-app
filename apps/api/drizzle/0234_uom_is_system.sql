-- uoms is FORCE RLS and the migrator is a plain table owner without a tenant
-- context (docs/plan/contracts.md, "Migrations: foreign keys into FORCE RLS
-- tables"). The backfill below would raise "tenant context is required" on a
-- populated database, so FORCE is lifted for this statement only and restored
-- before the file ends. Policies are not touched.
ALTER TABLE "uoms" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "uoms" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Matches the standard catalog by exact, case-sensitive code only. A legacy row
-- with a standard code but a renamed name keeps its name and becomes read-only:
-- provisioning never inserted a system row for that code (unique tenant+code).
UPDATE "uoms" SET "is_system" = true WHERE "code" IN ('kg', 'g', 'l', 'ml', 'pcs', 'pack', 'ctn', 'btl', 'can', 'sachet', 'box', 'porsi');--> statement-breakpoint
ALTER TABLE "uoms" FORCE ROW LEVEL SECURITY;
