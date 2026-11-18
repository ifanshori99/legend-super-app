-- legend-mrwtp: manual refund of a paid swap charge without payment intent
-- (cash out of the drawer or EDC). Foreign keys sit inside CREATE TABLE.
CREATE TABLE "order_issue_charge_manual_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"method" varchar(4) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"reason" varchar(500) NOT NULL,
	"reference" varchar(100),
	"status" varchar(10) DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"shift_id" uuid,
	"cash_movement_id" uuid,
	"reject_reason" varchar(500),
	CONSTRAINT "order_issue_charge_manual_refunds_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_issue_charge_manual_refunds_amount_check" CHECK ("order_issue_charge_manual_refunds"."amount_idr" > 0),
	CONSTRAINT "order_issue_charge_manual_refunds_method_check" CHECK ("order_issue_charge_manual_refunds"."method" IN ('cash', 'edc')),
	CONSTRAINT "order_issue_charge_manual_refunds_status_check" CHECK ("order_issue_charge_manual_refunds"."status" IN ('requested', 'completed', 'rejected')),
	CONSTRAINT "order_issue_charge_manual_refunds_reference_check" CHECK (("order_issue_charge_manual_refunds"."method" = 'edc' AND "order_issue_charge_manual_refunds"."reference" IS NOT NULL AND char_length("order_issue_charge_manual_refunds"."reference") BETWEEN 3 AND 100) OR ("order_issue_charge_manual_refunds"."method" = 'cash' AND "order_issue_charge_manual_refunds"."reference" IS NULL)),
	CONSTRAINT "order_issue_charge_manual_refunds_decided_check" CHECK (("order_issue_charge_manual_refunds"."status" = 'requested' AND "order_issue_charge_manual_refunds"."decided_by" IS NULL AND "order_issue_charge_manual_refunds"."decided_at" IS NULL) OR ("order_issue_charge_manual_refunds"."status" IN ('completed', 'rejected') AND "order_issue_charge_manual_refunds"."decided_by" IS NOT NULL AND "order_issue_charge_manual_refunds"."decided_at" IS NOT NULL)),
	CONSTRAINT "order_issue_charge_manual_refunds_reject_check" CHECK (("order_issue_charge_manual_refunds"."status" = 'rejected') = ("order_issue_charge_manual_refunds"."reject_reason" IS NOT NULL)),
	CONSTRAINT "order_issue_charge_manual_refunds_cash_check" CHECK ((("order_issue_charge_manual_refunds"."method" = 'cash' AND "order_issue_charge_manual_refunds"."status" = 'completed') = ("order_issue_charge_manual_refunds"."cash_movement_id" IS NOT NULL)) AND ("order_issue_charge_manual_refunds"."cash_movement_id" IS NULL OR "order_issue_charge_manual_refunds"."shift_id" IS NOT NULL) AND ("order_issue_charge_manual_refunds"."method" = 'cash' OR "order_issue_charge_manual_refunds"."shift_id" IS NULL)),
	CONSTRAINT "order_issue_charge_manual_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "order_issue_charge_manual_refunds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id"),
	CONSTRAINT "order_issue_charge_manual_refunds_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issue_charge_manual_refunds_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id"),
	CONSTRAINT "order_issue_charge_manual_refunds_charge_fk" FOREIGN KEY ("tenant_id","charge_id") REFERENCES "public"."order_issue_charges"("tenant_id","id"),
	CONSTRAINT "order_issue_charge_manual_refunds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id"),
	CONSTRAINT "order_issue_charge_manual_refunds_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id"),
	CONSTRAINT "order_issue_charge_manual_refunds_cash_movement_fk" FOREIGN KEY ("tenant_id","cash_movement_id") REFERENCES "public"."cash_movements"("tenant_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charge_manual_refunds_edc_reference_once_idx" ON "order_issue_charge_manual_refunds" USING btree ("tenant_id","method","reference") WHERE "order_issue_charge_manual_refunds"."method" = 'edc' AND "order_issue_charge_manual_refunds"."status" <> 'rejected';
--> statement-breakpoint
CREATE UNIQUE INDEX "order_issue_charge_manual_refunds_cash_movement_once_idx" ON "order_issue_charge_manual_refunds" USING btree ("tenant_id","cash_movement_id") WHERE "order_issue_charge_manual_refunds"."cash_movement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "order_issue_charge_manual_refunds_charge_idx" ON "order_issue_charge_manual_refunds" USING btree ("tenant_id","charge_id","status");
--> statement-breakpoint
-- legend-mrwtp: tenant + outlet RLS. Rows are updated (decided); never deleted.
SELECT app.enforce_tenant_rls('public.order_issue_charge_manual_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.order_issue_charge_manual_refunds'::regclass);
