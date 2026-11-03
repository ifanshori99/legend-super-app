ALTER TABLE "reservations" ADD COLUMN "deposit_payment_link_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "refund_payment_refund_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "refund_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "refund_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_deposit_link_fk" FOREIGN KEY ("tenant_id","deposit_payment_link_id") REFERENCES "public"."payment_links"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_refund_fk" FOREIGN KEY ("tenant_id","refund_payment_refund_id") REFERENCES "public"."payment_refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_deposit_link_key" ON "reservations" USING btree ("tenant_id","deposit_payment_link_id") WHERE "reservations"."deposit_payment_link_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reservations_refund_due_idx" ON "reservations" USING btree ("tenant_id","refund_next_attempt_at") WHERE "reservations"."refund_status" = 'pending';--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_refund_request_check" CHECK (("reservations"."refund_status" = 'requested') = ("reservations"."refund_payment_refund_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_refund_attempts_check" CHECK ("reservations"."refund_attempts" >= 0);