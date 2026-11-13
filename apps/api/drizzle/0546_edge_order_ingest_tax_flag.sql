-- Finance exceptions (docs/briefs/662-finance-exceptions-contract.md, item 1).
-- An edge order whose tax rows were not snapshotted records why: tax_missing
-- (no rows but PBJT > 0) or tax_mismatch (rows do not sum to PBJT). NULL for a
-- usable payload and for rows ingested before this migration.
ALTER TABLE "edge_order_ingests" ADD COLUMN "tax_flag" varchar(20);--> statement-breakpoint
ALTER TABLE "edge_order_ingests" ADD CONSTRAINT "edge_order_ingests_tax_flag_check" CHECK ("edge_order_ingests"."tax_flag" IS NULL OR "edge_order_ingests"."tax_flag" IN ('tax_missing', 'tax_mismatch')) NOT VALID;--> statement-breakpoint
ALTER TABLE "edge_order_ingests" VALIDATE CONSTRAINT "edge_order_ingests_tax_flag_check";
