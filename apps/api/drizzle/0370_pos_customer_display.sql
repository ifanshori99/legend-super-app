CREATE TABLE "customer_display_pair_attempts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"terminal_device_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_display_pair_attempts_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "customer_display_pair_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pair_attempts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pair_attempts_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "customer_display_pairing_codes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"display_device_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_display_pairing_codes_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "customer_display_pairing_codes_hash_check" CHECK (octet_length("customer_display_pairing_codes"."code_hash") = 32),
	CONSTRAINT "customer_display_pairing_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pairing_codes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pairing_codes_device_fk" FOREIGN KEY ("tenant_id","outlet_id","display_device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "customer_display_pairings" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"terminal_device_id" uuid NOT NULL,
	"display_device_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paired_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "customer_display_pairings_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "customer_display_pairings_status_check" CHECK ("customer_display_pairings"."status" IN ('active', 'revoked') AND (("customer_display_pairings"."status" = 'revoked') = ("customer_display_pairings"."revoked_at" IS NOT NULL))),
	CONSTRAINT "customer_display_pairings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pairings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pairings_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_pairings_display_fk" FOREIGN KEY ("tenant_id","outlet_id","display_device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "customer_display_sessions" (
	"tenant_id" uuid NOT NULL,
	"terminal_device_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"selected_order_id" uuid,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_display_sessions_pkey" PRIMARY KEY("tenant_id","terminal_device_id"),
	CONSTRAINT "customer_display_sessions_version_check" CHECK ("customer_display_sessions"."version" >= 0),
	CONSTRAINT "customer_display_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_sessions_terminal_fk" FOREIGN KEY ("tenant_id","outlet_id","terminal_device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_display_sessions_order_fk" FOREIGN KEY ("tenant_id","selected_order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "customer_display_pair_attempts_terminal_idx" ON "customer_display_pair_attempts" USING btree ("tenant_id","terminal_device_id","attempted_at");--> statement-breakpoint
CREATE INDEX "customer_display_pair_attempts_outlet_idx" ON "customer_display_pair_attempts" USING btree ("tenant_id","outlet_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_display_pairing_codes_live_code_key" ON "customer_display_pairing_codes" USING btree ("tenant_id","outlet_id","code_hash") WHERE "customer_display_pairing_codes"."consumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_display_pairing_codes_live_display_key" ON "customer_display_pairing_codes" USING btree ("tenant_id","display_device_id") WHERE "customer_display_pairing_codes"."consumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_display_pairings_active_display_key" ON "customer_display_pairings" USING btree ("tenant_id","display_device_id") WHERE "customer_display_pairings"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "customer_display_pairings_active_terminal_key" ON "customer_display_pairings" USING btree ("tenant_id","terminal_device_id") WHERE "customer_display_pairings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "customer_display_sessions_order_idx" ON "customer_display_sessions" USING btree ("tenant_id","selected_order_id") WHERE "customer_display_sessions"."selected_order_id" IS NOT NULL;
--> statement-breakpoint
-- legend-yhia9 C3 (migration 0370): customer display RLS and version triggers.
-- Append after the generated customer_display_* tables, FKs and indexes.
SELECT app.enforce_tenant_rls('public.customer_display_pairing_codes'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pairing_codes'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_pairings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pairings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_display_pair_attempts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_display_pair_attempts'::regclass);
--> statement-breakpoint

-- D-08 `version`: a per-terminal counter the display uses to drop older
-- answers. It moves when the bill a display shows changes its money or status
-- (orders) or its QRIS hold changes (pos_qris_holds). A selection change is
-- bumped by the service. A row hidden from the writer by RLS is not bumped
-- (the writer then has no business with that bill).
CREATE OR REPLACE FUNCTION app.customer_display_bump_for_order() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_order uuid;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_order := NEW.id;
  ELSE
    target_order := NEW.order_id;
  END IF;
  UPDATE public.customer_display_sessions
     SET version = version + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND selected_order_id = target_order;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "orders_customer_display_bump_trg"
  AFTER UPDATE ON "orders"
  FOR EACH ROW
  WHEN (NEW.subtotal_idr IS DISTINCT FROM OLD.subtotal_idr
    OR NEW.discount_idr IS DISTINCT FROM OLD.discount_idr
    OR NEW.service_charge_idr IS DISTINCT FROM OLD.service_charge_idr
    OR NEW.tax_idr IS DISTINCT FROM OLD.tax_idr
    OR NEW.rounding_idr IS DISTINCT FROM OLD.rounding_idr
    OR NEW.total_idr IS DISTINCT FROM OLD.total_idr
    OR NEW.deposit_applied_idr IS DISTINCT FROM OLD.deposit_applied_idr
    OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.customer_display_bump_for_order();
--> statement-breakpoint
CREATE TRIGGER "pos_qris_holds_customer_display_bump_trg"
  AFTER INSERT OR UPDATE OF state ON "pos_qris_holds"
  FOR EACH ROW EXECUTE FUNCTION app.customer_display_bump_for_order();
--> statement-breakpoint
-- Captured tenders change `remaining`: bump when a tender of the selected bill
-- is inserted or its status or amount moves.
CREATE OR REPLACE FUNCTION app.customer_display_bump_for_tender() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.customer_display_sessions
     SET version = version + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND selected_order_id = NEW.order_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_order_tenders_customer_display_bump_trg"
  AFTER INSERT OR UPDATE OF status, amount_idr ON "pos_order_tenders"
  FOR EACH ROW EXECUTE FUNCTION app.customer_display_bump_for_tender();
