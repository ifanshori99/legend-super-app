CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"reason" varchar(20),
	"message" varchar(500),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"assigned_to" uuid,
	"resolution_note" varchar(200),
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_requests_idempotency_key" UNIQUE("tenant_id","table_session_id","idempotency_key"),
	CONSTRAINT "service_requests_type_check" CHECK ("service_requests"."type" IN ('call_waiter', 'request_bill', 'complaint')),
	CONSTRAINT "service_requests_reason_check" CHECK ("service_requests"."reason" IS NULL OR "service_requests"."reason" IN ('add_order', 'utensils', 'complaint', 'other')),
	CONSTRAINT "service_requests_status_check" CHECK ("service_requests"."status" IN ('pending', 'acknowledged', 'resolved', 'cancelled')),
	CONSTRAINT "service_requests_lifecycle_check" CHECK (("service_requests"."status" <> 'pending' OR "service_requests"."acknowledged_at" IS NULL)
        AND ("service_requests"."status" <> 'acknowledged' OR ("service_requests"."acknowledged_at" IS NOT NULL AND "service_requests"."assigned_to" IS NOT NULL))
        AND (("service_requests"."status" = 'resolved') = ("service_requests"."resolved_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "zone_waiter_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zone_waiter_assignments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "zone_waiter_assignments_zone_user_key" UNIQUE("tenant_id","zone_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pos_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"action" varchar(30) NOT NULL,
	"method" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"reason_code" varchar(50),
	"reason" varchar(500) NOT NULL,
	"value_idr" bigint NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"approval_request_id" uuid,
	"idempotency_key" varchar(100),
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pos_overrides_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_overrides_action_check" CHECK ("pos_overrides"."action" IN ('void', 'discount', 'refund', 'cash_drawer_open', 'price_correction')),
	CONSTRAINT "pos_overrides_method_check" CHECK ("pos_overrides"."method" IN ('supervisor_pin', 'supervisor_phone')),
	CONSTRAINT "pos_overrides_status_check" CHECK ("pos_overrides"."status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "pos_overrides_approver_check" CHECK (("pos_overrides"."status" = 'approved') = ("pos_overrides"."approved_by" IS NOT NULL)),
	CONSTRAINT "pos_overrides_distinct_actor_check" CHECK ("pos_overrides"."approved_by" IS NULL OR "pos_overrides"."approved_by" <> "pos_overrides"."requested_by"),
	CONSTRAINT "pos_overrides_method_link_check" CHECK (("pos_overrides"."method" = 'supervisor_phone') = ("pos_overrides"."approval_request_id" IS NOT NULL) AND ("pos_overrides"."method" <> 'supervisor_pin' OR "pos_overrides"."status" = 'approved')),
	CONSTRAINT "pos_overrides_resolved_check" CHECK (("pos_overrides"."status" = 'pending') = ("pos_overrides"."resolved_at" IS NULL)),
	CONSTRAINT "pos_overrides_value_check" CHECK ("pos_overrides"."value_idr" >= 0 AND char_length("pos_overrides"."reason") >= 3)
);
--> statement-breakpoint
CREATE TABLE "staff_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"pin_hash" varchar(64) NOT NULL,
	"pin_salt" varchar(24) NOT NULL,
	"kdf_n" integer NOT NULL,
	"kdf_r" integer NOT NULL,
	"kdf_p" integer NOT NULL,
	"pepper_version" integer DEFAULT 1 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"set_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_pins_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_pins_tenant_outlet_user_key" UNIQUE("tenant_id","outlet_id","user_id"),
	CONSTRAINT "staff_pins_hash_check" CHECK ("staff_pins"."pin_hash" ~ '^[0-9a-f]{64}$' AND char_length("staff_pins"."pin_salt") = 24),
	CONSTRAINT "staff_pins_attempts_check" CHECK ("staff_pins"."failed_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "staff_pins_kdf_check" CHECK ("staff_pins"."kdf_n" >= 1024 AND "staff_pins"."kdf_r" >= 1 AND "staff_pins"."kdf_p" >= 1 AND "staff_pins"."pepper_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "cart_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"name" varchar(150) NOT NULL,
	"quantity" smallint NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" varchar(200),
	"unit_price_idr" bigint NOT NULL,
	"modifiers_total_idr" bigint DEFAULT 0 NOT NULL,
	"added_by_participant_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cart_lines_quantity_check" CHECK ("cart_lines"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "cart_lines_unit_price_check" CHECK ("cart_lines"."unit_price_idr" > 0),
	CONSTRAINT "cart_lines_modifiers_total_check" CHECK ("cart_lines"."modifiers_total_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"variant_id" uuid,
	"name" varchar(150) NOT NULL,
	"quantity" smallint NOT NULL,
	"unit_price_idr" bigint NOT NULL,
	"modifiers_total_idr" bigint NOT NULL,
	"line_total_idr" bigint NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" varchar(200),
	"course" varchar(20),
	"fire_status" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"reserved_business_date" date NOT NULL,
	"void_reason" varchar(100),
	"voided_by" uuid,
	"void_approved_by" uuid,
	"cost_snapshot_idr" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "order_items_line_total_check" CHECK ("order_items"."line_total_idr" = ("order_items"."unit_price_idr" + "order_items"."modifiers_total_idr") * "order_items"."quantity"),
	CONSTRAINT "order_items_fire_status_check" CHECK ("order_items"."fire_status" IN ('held', 'fired')),
	CONSTRAINT "order_items_status_check" CHECK ("order_items"."status" IN ('queued', 'in_progress', 'ready', 'served', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"number" varchar(30) NOT NULL,
	"channel" varchar(20) NOT NULL,
	"service_type" varchar(20) NOT NULL,
	"table_session_id" uuid,
	"customer_profile_id" uuid,
	"external_ref" varchar(100),
	"payment_mode" varchar(20) NOT NULL,
	"subtotal_idr" bigint NOT NULL,
	"discount_idr" bigint NOT NULL,
	"service_charge_idr" bigint NOT NULL,
	"tax_idr" bigint NOT NULL,
	"rounding_idr" bigint NOT NULL,
	"total_idr" bigint NOT NULL,
	"deposit_applied_idr" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) NOT NULL,
	"business_date" date NOT NULL,
	"tax_result" jsonb,
	"payment_link_id" uuid,
	"payment_link_token_sealed" text,
	"payment_intent_id" uuid,
	"note" varchar(200),
	"created_by" uuid,
	"placed_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_tenant_outlet_number_key" UNIQUE("tenant_id","outlet_id","number"),
	CONSTRAINT "orders_channel_check" CHECK ("orders"."channel" IN ('qr')),
	CONSTRAINT "orders_service_type_check" CHECK ("orders"."service_type" IN ('dine_in', 'takeaway', 'delivery')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('draft', 'awaiting_payment', 'sent', 'completed', 'voided')),
	CONSTRAINT "orders_payment_mode_check" CHECK ("orders"."payment_mode" IN ('pay_first', 'open_bill')),
	CONSTRAINT "orders_amounts_check" CHECK ("orders"."subtotal_idr" >= 0 AND "orders"."discount_idr" >= 0 AND "orders"."service_charge_idr" >= 0 AND "orders"."tax_idr" >= 0 AND "orders"."total_idr" >= 0 AND "orders"."deposit_applied_idr" >= 0 AND "orders"."deposit_applied_idr" <= "orders"."total_idr"),
	CONSTRAINT "orders_total_check" CHECK ("orders"."total_idr" = "orders"."subtotal_idr" - "orders"."discount_idr" + "orders"."service_charge_idr" + "orders"."tax_idr" + "orders"."rounding_idr"),
	CONSTRAINT "orders_payment_link_pair_check" CHECK (("orders"."payment_link_id" IS NULL) = ("orders"."payment_link_token_sealed" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "qr_order_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_order_idempotency_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qr_order_idempotency_key" UNIQUE("tenant_id","table_session_id","key")
);
--> statement-breakpoint
CREATE TABLE "table_session_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"promo_code" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_session_carts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "table_session_carts_session_key" UNIQUE("tenant_id","table_session_id"),
	CONSTRAINT "table_session_carts_version_check" CHECK ("table_session_carts"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."tables"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiter_assignments" ADD CONSTRAINT "zone_waiter_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiter_assignments" ADD CONSTRAINT "zone_waiter_assignments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiter_assignments" ADD CONSTRAINT "zone_waiter_assignments_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_waiter_assignments" ADD CONSTRAINT "zone_waiter_assignments_zone_fk" FOREIGN KEY ("tenant_id","zone_id") REFERENCES "public"."floor_zones"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_overrides" ADD CONSTRAINT "pos_overrides_approval_request_fk" FOREIGN KEY ("tenant_id","approval_request_id") REFERENCES "public"."approval_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_cart_fk" FOREIGN KEY ("tenant_id","cart_id") REFERENCES "public"."table_session_carts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_menu_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_participant_fk" FOREIGN KEY ("tenant_id","added_by_participant_id") REFERENCES "public"."session_participants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_fk" FOREIGN KEY ("tenant_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_idempotency" ADD CONSTRAINT "qr_order_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_idempotency" ADD CONSTRAINT "qr_order_idempotency_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_idempotency" ADD CONSTRAINT "qr_order_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_order_idempotency" ADD CONSTRAINT "qr_order_idempotency_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_carts" ADD CONSTRAINT "table_session_carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_carts" ADD CONSTRAINT "table_session_carts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_carts" ADD CONSTRAINT "table_session_carts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_carts" ADD CONSTRAINT "table_session_carts_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_requests_open_dedupe_key" ON "service_requests" USING btree ("tenant_id","table_id","type") WHERE "service_requests"."status" IN ('pending', 'acknowledged');--> statement-breakpoint
CREATE INDEX "service_requests_outlet_inbox_idx" ON "service_requests" USING btree ("tenant_id","outlet_id","created_at","id");--> statement-breakpoint
CREATE INDEX "service_requests_open_age_idx" ON "service_requests" USING btree ("tenant_id","created_at") WHERE "service_requests"."status" IN ('pending', 'acknowledged');--> statement-breakpoint
CREATE INDEX "zone_waiter_assignments_zone_idx" ON "zone_waiter_assignments" USING btree ("tenant_id","outlet_id","zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_overrides_idempotency_key" ON "pos_overrides" USING btree ("tenant_id","requested_by","idempotency_key") WHERE "pos_overrides"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_overrides_approval_request_key" ON "pos_overrides" USING btree ("tenant_id","approval_request_id") WHERE "pos_overrides"."approval_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pos_overrides_outlet_idx" ON "pos_overrides" USING btree ("tenant_id","outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "cart_lines_cart_idx" ON "cart_lines" USING btree ("tenant_id","cart_id","added_at","id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("tenant_id","order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_payment_link_key" ON "orders" USING btree ("tenant_id","payment_link_id") WHERE "orders"."payment_link_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_session_idx" ON "orders" USING btree ("tenant_id","table_session_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_outlet_status_idx" ON "orders" USING btree ("tenant_id","outlet_id","status","placed_at");