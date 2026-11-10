-- legend-44g8n: forward migration for the cash collection of a swap charge
-- (legend-800h1). These columns, constraints and the index used to be edited
-- into 0229 in place; a database that already ran the old 0229 never got them.
-- 0229 is back to its shipped text and this migration adds them for every
-- database, fresh or old.
ALTER TABLE "order_issue_charges" ADD COLUMN "cash_movement_id" uuid;--> statement-breakpoint
ALTER TABLE "order_issue_charges" ADD COLUMN "paid_by" text;--> statement-breakpoint
ALTER TABLE "order_issue_charges" DROP CONSTRAINT "order_issue_charges_route_status_check";--> statement-breakpoint
ALTER TABLE "order_issue_charges" ADD CONSTRAINT "order_issue_charges_route_status_check" CHECK (("order_issue_charges"."route" = 'pos') = ("order_issue_charges"."status" = 'routed_pos') OR "order_issue_charges"."status" IN ('paid', 'waived', 'expired'));--> statement-breakpoint
ALTER TABLE "order_issue_charges" ADD CONSTRAINT "order_issue_charges_cash_paid_check" CHECK ("order_issue_charges"."cash_movement_id" IS NULL OR ("order_issue_charges"."status" = 'paid' AND "order_issue_charges"."payment_intent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "order_issue_charges" ADD CONSTRAINT "order_issue_charges_paid_by_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."user"("id");--> statement-breakpoint
ALTER TABLE "order_issue_charges" ADD CONSTRAINT "order_issue_charges_cash_movement_fk" FOREIGN KEY ("tenant_id","cash_movement_id") REFERENCES "public"."cash_movements"("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charges_cash_movement_once_idx" ON "order_issue_charges" USING btree ("tenant_id","cash_movement_id") WHERE "order_issue_charges"."cash_movement_id" IS NOT NULL;
