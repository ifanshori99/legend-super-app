-- PAY recon: a "missing" case (settlement_line_id IS NULL) is one per sale for
-- life, whatever its status, keyed by the sale id (card approval codes repeat
-- across sales). Legacy rows keep a null id and are deduped by reference.
ALTER TABLE "payment_reconciliation_cases" ADD COLUMN "source_transaction_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_cases_missing_sale_key" ON "payment_reconciliation_cases" USING btree ("tenant_id","outlet_id","source","source_transaction_id") WHERE "payment_reconciliation_cases"."settlement_line_id" IS NULL AND "payment_reconciliation_cases"."source_transaction_id" IS NOT NULL;
