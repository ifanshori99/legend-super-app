-- legend-rhq5: PPh 21 scheme of the employment agreement.
-- Explicit backfill: every contract that exists before this migration is
-- 'gross' (CTO decision 2026-11-09). ADD COLUMN ... DEFAULT fills the existing
-- rows inside the DDL itself, with no per-row UPDATE, so no row goes through
-- the FORCE ROW LEVEL SECURITY tenant policy on this table and no tenant
-- context or BYPASSRLS is needed (simpler than the NO FORCE / UPDATE / FORCE
-- pattern of 0096). The default is dropped right after: new contracts must
-- state their scheme, never a silent 'gross'.
ALTER TABLE "employment_contracts" ADD COLUMN "tax_scheme" varchar(20) NOT NULL DEFAULT 'gross';--> statement-breakpoint
ALTER TABLE "employment_contracts" ALTER COLUMN "tax_scheme" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_tax_scheme_check" CHECK ("employment_contracts"."tax_scheme" IN ('gross', 'gross_up', 'net'));
