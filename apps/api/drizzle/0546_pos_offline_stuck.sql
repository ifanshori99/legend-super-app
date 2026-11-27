-- 1273 second opinion P2-1: a stuck_<reason> hold (a sale the tablet could
-- never send, reported with a supervisor PIN) keeps whatever number it names,
-- like a number_taken hold; every other offline sale keeps the number unique.
DROP INDEX "pos_offline_sales_sequence_number_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "pos_offline_sales_sequence_number_uidx" ON "pos_offline_sales" USING btree ("tenant_id","sequence_id","sequence_number") WHERE "pos_offline_sales"."reason" IS DISTINCT FROM 'number_taken' AND left("pos_offline_sales"."reason", 6) IS DISTINCT FROM 'stuck_';