CREATE TABLE "payment_refund_escalation_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"pending_unapproved_hours" integer DEFAULT 24 NOT NULL,
	"provider_pending_hours" integer DEFAULT 72 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_escalation_pending_hours_check" CHECK ("payment_refund_escalation_settings"."pending_unapproved_hours" BETWEEN 1 AND 720),
	CONSTRAINT "payment_refund_escalation_provider_hours_check" CHECK ("payment_refund_escalation_settings"."provider_pending_hours" BETWEEN 1 AND 720)
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "escalation_reason" varchar(30);--> statement-breakpoint
ALTER TABLE "payment_refund_escalation_settings" ADD CONSTRAINT "payment_refund_escalation_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_refunds_status_created_idx" ON "payment_refunds" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_escalation_reason_check" CHECK ("payment_refunds"."escalation_reason" IS NULL OR "payment_refunds"."escalation_reason" IN ('pending_unapproved','provider_pending'));--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_escalation_pair_check" CHECK (("payment_refunds"."escalated_at" IS NULL) = ("payment_refunds"."escalation_reason" IS NULL));