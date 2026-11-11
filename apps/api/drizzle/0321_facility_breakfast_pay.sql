CREATE TABLE "facility_linked_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"access_ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"delivery" jsonb NOT NULL,
	"subtotal_idr" bigint NOT NULL,
	"total_idr" bigint NOT NULL,
	"paid_idr" bigint DEFAULT 0 NOT NULL,
	"paid_intent_id" uuid,
	"paid_at" timestamp with time zone,
	"fire_offset_minutes" integer NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refunded_idr" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(120) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_linked_orders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_linked_orders_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "facility_linked_orders_idempotency_key" UNIQUE("tenant_id","access_ticket_id","idempotency_key"),
	CONSTRAINT "facility_linked_orders_status_check" CHECK ("facility_linked_orders"."status" IN ('awaiting_payment', 'paid', 'fired', 'cancelled')),
	CONSTRAINT "facility_linked_orders_amounts_check" CHECK ("facility_linked_orders"."subtotal_idr" >= 0 AND "facility_linked_orders"."total_idr" >= 0 AND "facility_linked_orders"."paid_idr" >= 0 AND "facility_linked_orders"."refunded_idr" >= 0),
	CONSTRAINT "facility_linked_orders_fire_offset_check" CHECK ("facility_linked_orders"."fire_offset_minutes" BETWEEN 0 AND 240),
	CONSTRAINT "facility_linked_orders_paid_check" CHECK ("facility_linked_orders"."status" NOT IN ('paid', 'fired') OR ("facility_linked_orders"."paid_at" IS NOT NULL AND "facility_linked_orders"."paid_intent_id" IS NOT NULL AND "facility_linked_orders"."paid_idr" = "facility_linked_orders"."total_idr")),
	CONSTRAINT "facility_linked_orders_fired_check" CHECK ("facility_linked_orders"."status" <> 'fired' OR "facility_linked_orders"."fired_at" IS NOT NULL),
	CONSTRAINT "facility_linked_orders_cancelled_check" CHECK ("facility_linked_orders"."status" <> 'cancelled' OR "facility_linked_orders"."cancelled_at" IS NOT NULL),
	CONSTRAINT "facility_linked_orders_refund_check" CHECK ("facility_linked_orders"."refunded_idr" <= "facility_linked_orders"."paid_idr")
);
--> statement-breakpoint
ALTER TABLE "facility_linked_orders" ADD CONSTRAINT "facility_linked_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_linked_orders" ADD CONSTRAINT "facility_linked_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_linked_orders" ADD CONSTRAINT "facility_linked_orders_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_linked_orders" ADD CONSTRAINT "facility_linked_orders_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_linked_orders" ADD CONSTRAINT "facility_linked_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facility_linked_orders_ticket_live_key" ON "facility_linked_orders" USING btree ("tenant_id","access_ticket_id") WHERE "facility_linked_orders"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "facility_linked_orders_fire_due_idx" ON "facility_linked_orders" USING btree ("tenant_id","fire_at") WHERE "facility_linked_orders"."status" = 'paid';
--> statement-breakpoint
-- Custom SQL (bead oa0qk; mirrors the fragments in
-- src/db/schema/facility.custom.sql, kds.custom.sql, pos-order.custom.sql).

-- 1. Tenant + outlet RLS (TEN-01, TEN-03).
SELECT app.enforce_tenant_rls('public.facility_linked_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_linked_orders'::regclass);
--> statement-breakpoint

-- 2. Widen the `orders.channel` check with 'facility' (breakfast ordered from
--    an access ticket). The drizzle snapshot still records ('qr') for this
--    check (see 0060), so no schema diff is produced.
ALTER TABLE "orders" DROP CONSTRAINT "orders_channel_check";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_check"
  CHECK ("channel" IN ('qr', 'pos', 'captain', 'gofood', 'grabfood', 'shopeefood', 'reservation', 'kiosk', 'facility'));
--> statement-breakpoint

-- 3. Owner Q43 backstop: a `facility` (breakfast) order reaches the kitchen
--    only once paid. Runs as the caller, so tenant/outlet RLS applies like
--    any kitchen write; both lookups are filtered by NEW.tenant_id as well.
CREATE FUNCTION app.kitchen_tickets_breakfast_paid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.orders o
       WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id
         AND o.channel = 'facility'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.facility_linked_orders f
       WHERE f.tenant_id = NEW.tenant_id AND f.order_id = NEW.order_id
         AND f.paid_at IS NOT NULL AND f.status IN ('paid', 'fired')
     ) THEN
    RAISE EXCEPTION 'breakfast order % is not paid and cannot reach the kitchen', NEW.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'kitchen_tickets_breakfast_paid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.kitchen_tickets_breakfast_paid() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "kitchen_tickets_breakfast_paid_trg"
  BEFORE INSERT ON "kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION app.kitchen_tickets_breakfast_paid();
