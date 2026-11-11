CREATE INDEX "orders_tenant_payment_intent_idx" ON "orders" USING btree ("tenant_id","payment_intent_id") WHERE "orders"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pos_order_tenders_payment_intent_idx" ON "pos_order_tenders" USING btree ("tenant_id","payment_intent_id") WHERE "pos_order_tenders"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_intents_order_idx" ON "payment_intents" USING btree ("tenant_id","order_id") WHERE "payment_intents"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_intents_bill_split_idx" ON "payment_intents" USING btree ("tenant_id","bill_split_id") WHERE "payment_intents"."bill_split_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_intents_reservation_idx" ON "payment_intents" USING btree ("tenant_id","reservation_id") WHERE "payment_intents"."reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bill_splits_order_idx" ON "bill_splits" USING btree ("tenant_id","order_id");
