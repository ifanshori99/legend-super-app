CREATE TABLE "reservation_deposit_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_deposit_allocations_reservation_key" UNIQUE("tenant_id","reservation_id"),
	CONSTRAINT "reservation_deposit_allocations_amount_check" CHECK ("reservation_deposit_allocations"."amount_idr" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_idempotency" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"operation" varchar(30) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"reservation_id" uuid,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "reservation_idempotency_fingerprint_check" CHECK ("reservation_idempotency"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "reservation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"version" varchar(40) NOT NULL,
	"deposit_requirement" varchar(20) NOT NULL,
	"deposit_amount_idr" bigint NOT NULL,
	"payment_window_minutes" integer NOT NULL,
	"free_cancellation_hours" integer NOT NULL,
	"late_cancellation_refund_bp" integer NOT NULL,
	"no_show_refund_bp" integer NOT NULL,
	"minimum_spend_idr" bigint NOT NULL,
	"default_duration_minutes" integer DEFAULT 90 NOT NULL,
	"slot_interval_minutes" integer DEFAULT 30 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservation_policies_tenant_outlet_version_key" UNIQUE("tenant_id","outlet_id","version"),
	CONSTRAINT "reservation_policies_requirement_check" CHECK ("reservation_policies"."deposit_requirement" IN ('none', 'required', 'optional')),
	CONSTRAINT "reservation_policies_amounts_check" CHECK ("reservation_policies"."deposit_amount_idr" >= 0 AND "reservation_policies"."minimum_spend_idr" >= 0
        AND ("reservation_policies"."deposit_requirement" <> 'none' OR "reservation_policies"."deposit_amount_idr" = 0)
        AND ("reservation_policies"."deposit_requirement" <> 'required' OR "reservation_policies"."deposit_amount_idr" > 0)),
	CONSTRAINT "reservation_policies_rules_check" CHECK ("reservation_policies"."payment_window_minutes" BETWEEN 5 AND 1440
        AND "reservation_policies"."free_cancellation_hours" BETWEEN 0 AND 720
        AND "reservation_policies"."late_cancellation_refund_bp" BETWEEN 0 AND 10000
        AND "reservation_policies"."no_show_refund_bp" BETWEEN 0 AND 10000
        AND "reservation_policies"."default_duration_minutes" BETWEEN 15 AND 720
        AND "reservation_policies"."slot_interval_minutes" BETWEEN 5 AND 240)
);
--> statement-breakpoint
CREATE TABLE "reservation_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"hold_range" "tstzrange" GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_tables_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservation_tables_range_check" CHECK ("reservation_tables"."ends_at" > "reservation_tables"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"customer_profile_id" uuid,
	"guest_name" varchar(150) NOT NULL,
	"contact_hash" varchar(64),
	"reserved_for" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"pax" smallint NOT NULL,
	"zone_id" uuid,
	"deposit_idr" bigint NOT NULL,
	"deposit_payment_id" uuid,
	"deposit_link_sealed" text,
	"deposit_link_expires_at" timestamp with time zone,
	"policy_snapshot" jsonb NOT NULL,
	"status" varchar(20) NOT NULL,
	"note" varchar(300),
	"source" varchar(20) NOT NULL,
	"seated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" varchar(300),
	"deposit_refund_idr" bigint,
	"deposit_forfeited_idr" bigint,
	"refund_status" varchar(20) DEFAULT 'not_required' NOT NULL,
	"table_session_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" IN ('pending_deposit', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
	CONSTRAINT "reservations_source_check" CHECK ("reservations"."source" IN ('website', 'staff', 'whatsapp')),
	CONSTRAINT "reservations_size_check" CHECK ("reservations"."pax" BETWEEN 1 AND 60 AND "reservations"."duration_minutes" BETWEEN 15 AND 720),
	CONSTRAINT "reservations_deposit_check" CHECK ("reservations"."deposit_idr" >= 0),
	CONSTRAINT "reservations_contact_hash_check" CHECK ("reservations"."contact_hash" IS NULL OR "reservations"."contact_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "reservations_closed_check" CHECK (("reservations"."status" IN ('cancelled', 'no_show')) = ("reservations"."closed_at" IS NOT NULL)),
	CONSTRAINT "reservations_seated_check" CHECK ("reservations"."status" NOT IN ('seated', 'completed') OR ("reservations"."seated_at" IS NOT NULL AND "reservations"."table_session_id" IS NOT NULL)),
	CONSTRAINT "reservations_completed_check" CHECK ("reservations"."status" <> 'completed' OR "reservations"."completed_at" IS NOT NULL),
	CONSTRAINT "reservations_outcome_check" CHECK (("reservations"."deposit_refund_idr" IS NULL) = ("reservations"."deposit_forfeited_idr" IS NULL)
        AND ("reservations"."deposit_refund_idr" IS NULL OR ("reservations"."deposit_refund_idr" >= 0 AND "reservations"."deposit_forfeited_idr" >= 0))),
	CONSTRAINT "reservations_refund_status_check" CHECK ("reservations"."refund_status" IN ('not_required', 'pending', 'requested'))
);
--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_deposit_allocations" ADD CONSTRAINT "reservation_deposit_allocations_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_idempotency" ADD CONSTRAINT "reservation_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_idempotency" ADD CONSTRAINT "reservation_idempotency_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_idempotency" ADD CONSTRAINT "reservation_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_idempotency" ADD CONSTRAINT "reservation_idempotency_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_policies" ADD CONSTRAINT "reservation_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_policies" ADD CONSTRAINT "reservation_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_policies" ADD CONSTRAINT "reservation_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."tables"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_deposit_payment_fk" FOREIGN KEY ("tenant_id","deposit_payment_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_table_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_deposit_allocations_session_idx" ON "reservation_deposit_allocations" USING btree ("tenant_id","table_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_policies_active_key" ON "reservation_policies" USING btree ("tenant_id","outlet_id") WHERE "reservation_policies"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_tables_live_key" ON "reservation_tables" USING btree ("tenant_id","reservation_id","table_id") WHERE "reservation_tables"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservation_tables_reservation_idx" ON "reservation_tables" USING btree ("tenant_id","reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_tables_table_idx" ON "reservation_tables" USING btree ("tenant_id","outlet_id","table_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_outlet_time_idx" ON "reservations" USING btree ("tenant_id","outlet_id","reserved_for","id");--> statement-breakpoint
CREATE INDEX "reservations_outlet_status_idx" ON "reservations" USING btree ("tenant_id","outlet_id","status");