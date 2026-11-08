CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" varchar(10) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"reason_note" varchar(500) NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"approved_by" text,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_movements_idempotency_key" UNIQUE("tenant_id","shift_id","idempotency_key"),
	CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('cash_in', 'cash_out', 'drop')),
	CONSTRAINT "cash_movements_amount_check" CHECK ("cash_movements"."amount_idr" > 0),
	CONSTRAINT "cash_movements_reason_check" CHECK (char_length("cash_movements"."reason_note") >= 4)
);
--> statement-breakpoint
CREATE TABLE "pos_daily_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"order_count" integer NOT NULL,
	"total_sales_idr" bigint NOT NULL,
	"total_refunds_idr" bigint NOT NULL,
	"total_voids_idr" bigint NOT NULL,
	"total_variance_idr" bigint NOT NULL,
	"inventory_deduction_applied" boolean NOT NULL,
	"recap" jsonb NOT NULL,
	"closed_by" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_daily_closes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_daily_closes_day_key" UNIQUE("tenant_id","outlet_id","business_date"),
	CONSTRAINT "pos_daily_closes_idempotency_key" UNIQUE("tenant_id","outlet_id","idempotency_key"),
	CONSTRAINT "pos_daily_closes_amounts_check" CHECK ("pos_daily_closes"."order_count" >= 0 AND "pos_daily_closes"."total_sales_idr" >= 0
        AND "pos_daily_closes"."total_refunds_idr" >= 0 AND "pos_daily_closes"."total_voids_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"cashier_id" text NOT NULL,
	"business_date" date NOT NULL,
	"status" varchar(10) NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_float_idr" bigint NOT NULL,
	"cash_sales_idr" bigint DEFAULT 0 NOT NULL,
	"cash_refunds_idr" bigint DEFAULT 0 NOT NULL,
	"cash_in_idr" bigint DEFAULT 0 NOT NULL,
	"cash_out_idr" bigint DEFAULT 0 NOT NULL,
	"cash_drop_idr" bigint DEFAULT 0 NOT NULL,
	"expected_idr" bigint,
	"counted_idr" bigint,
	"variance_idr" bigint,
	"variance_note" varchar(500),
	"counts" jsonb,
	"approved_by" text,
	"approval_request_id" uuid,
	"approval_override_id" uuid,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"open_key" varchar(100) NOT NULL,
	"open_fingerprint" varchar(64) NOT NULL,
	"close_key" varchar(100),
	"close_fingerprint" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_shifts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_shifts_open_key" UNIQUE("tenant_id","outlet_id","open_key"),
	CONSTRAINT "pos_shifts_status_check" CHECK ("pos_shifts"."status" IN ('open', 'closed')),
	CONSTRAINT "pos_shifts_amounts_check" CHECK ("pos_shifts"."opening_float_idr" >= 0 AND "pos_shifts"."cash_sales_idr" >= 0
        AND "pos_shifts"."cash_refunds_idr" >= 0 AND "pos_shifts"."cash_in_idr" >= 0
        AND "pos_shifts"."cash_out_idr" >= 0 AND "pos_shifts"."cash_drop_idr" >= 0
        AND ("pos_shifts"."expected_idr" IS NULL OR "pos_shifts"."expected_idr" >= 0)
        AND ("pos_shifts"."counted_idr" IS NULL OR "pos_shifts"."counted_idr" >= 0)),
	CONSTRAINT "pos_shifts_open_check" CHECK ("pos_shifts"."status" <> 'open' OR ("pos_shifts"."expected_idr" IS NULL
        AND "pos_shifts"."counted_idr" IS NULL AND "pos_shifts"."variance_idr" IS NULL
        AND "pos_shifts"."variance_note" IS NULL AND "pos_shifts"."counts" IS NULL
        AND "pos_shifts"."approved_by" IS NULL AND "pos_shifts"."approval_request_id" IS NULL
        AND "pos_shifts"."approval_override_id" IS NULL AND "pos_shifts"."approved_at" IS NULL
        AND "pos_shifts"."closed_at" IS NULL AND "pos_shifts"."closed_by" IS NULL
        AND "pos_shifts"."close_key" IS NULL AND "pos_shifts"."close_fingerprint" IS NULL)),
	CONSTRAINT "pos_shifts_closed_check" CHECK ("pos_shifts"."status" <> 'closed' OR ("pos_shifts"."expected_idr" IS NOT NULL
        AND "pos_shifts"."counted_idr" IS NOT NULL AND "pos_shifts"."variance_idr" IS NOT NULL
        AND "pos_shifts"."counts" IS NOT NULL
        AND "pos_shifts"."approved_by" IS NOT NULL AND "pos_shifts"."approval_request_id" IS NOT NULL
        AND "pos_shifts"."approval_override_id" IS NOT NULL AND "pos_shifts"."approved_at" IS NOT NULL
        AND "pos_shifts"."closed_at" IS NOT NULL AND "pos_shifts"."closed_by" IS NOT NULL
        AND "pos_shifts"."close_key" IS NOT NULL AND "pos_shifts"."close_fingerprint" IS NOT NULL
        AND "pos_shifts"."expected_idr" = "pos_shifts"."opening_float_idr" + "pos_shifts"."cash_sales_idr"
          - "pos_shifts"."cash_refunds_idr" + "pos_shifts"."cash_in_idr" - "pos_shifts"."cash_out_idr"
          - "pos_shifts"."cash_drop_idr"
        AND "pos_shifts"."variance_idr" = "pos_shifts"."counted_idr" - "pos_shifts"."expected_idr"
        AND ("pos_shifts"."variance_idr" = 0 OR "pos_shifts"."variance_note" IS NOT NULL))),
	CONSTRAINT "pos_shifts_approver_check" CHECK ("pos_shifts"."approved_by" IS NULL OR lower("pos_shifts"."approved_by") <> lower("pos_shifts"."cashier_id"))
);
--> statement-breakpoint
ALTER TABLE "pos_overrides" DROP CONSTRAINT "pos_overrides_action_check";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_daily_closes" ADD CONSTRAINT "pos_daily_closes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_daily_closes" ADD CONSTRAINT "pos_daily_closes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_daily_closes" ADD CONSTRAINT "pos_daily_closes_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_daily_closes" ADD CONSTRAINT "pos_daily_closes_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_cashier_id_user_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_shift_idx" ON "cash_movements" USING btree ("tenant_id","shift_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_open_device_key" ON "pos_shifts" USING btree ("tenant_id","outlet_id","device_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_open_cashier_key" ON "pos_shifts" USING btree ("tenant_id","outlet_id","cashier_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_approval_override_key" ON "pos_shifts" USING btree ("tenant_id","approval_override_id") WHERE "pos_shifts"."approval_override_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pos_shifts_outlet_date_idx" ON "pos_shifts" USING btree ("tenant_id","outlet_id","business_date","opened_at");--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_action_check" CHECK ("pos_overrides"."action" IN ('void', 'discount', 'refund', 'cash_drawer_open', 'price_correction', 'cash_shift_close'));