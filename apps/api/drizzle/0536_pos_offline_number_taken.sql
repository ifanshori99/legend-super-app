-- Review O2 P3 1 (legend-wasr7.6): a number_taken hold shares its number with
-- the sale that holds it; every other offline sale keeps the number unique.
ALTER TABLE "pos_offline_sales" DROP CONSTRAINT "pos_offline_sales_sequence_number_key";--> statement-breakpoint
CREATE UNIQUE INDEX "pos_offline_sales_sequence_number_uidx" ON "pos_offline_sales" USING btree ("tenant_id","sequence_id","sequence_number") WHERE "pos_offline_sales"."reason" IS DISTINCT FROM 'number_taken';