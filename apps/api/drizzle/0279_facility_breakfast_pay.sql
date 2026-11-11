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
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): an ALTER TABLE ... ADD FOREIGN KEY
	-- validates under the FORCE RLS parent policy and aborts a plain-owner
	-- migrator without app.tenant_id.
	CONSTRAINT "facility_linked_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_linked_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_linked_orders_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_linked_orders_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_linked_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_linked_orders_status_check" CHECK ("facility_linked_orders"."status" IN ('awaiting_payment', 'paid', 'fired', 'cancelled')),
	CONSTRAINT "facility_linked_orders_amounts_check" CHECK ("facility_linked_orders"."subtotal_idr" >= 0 AND "facility_linked_orders"."total_idr" >= 0 AND "facility_linked_orders"."paid_idr" >= 0 AND "facility_linked_orders"."refunded_idr" >= 0),
	CONSTRAINT "facility_linked_orders_fire_offset_check" CHECK ("facility_linked_orders"."fire_offset_minutes" BETWEEN 0 AND 240),
	CONSTRAINT "facility_linked_orders_paid_check" CHECK ("facility_linked_orders"."status" NOT IN ('paid', 'fired') OR ("facility_linked_orders"."paid_at" IS NOT NULL AND "facility_linked_orders"."paid_intent_id" IS NOT NULL AND "facility_linked_orders"."paid_idr" = "facility_linked_orders"."total_idr")),
	CONSTRAINT "facility_linked_orders_fired_check" CHECK ("facility_linked_orders"."status" <> 'fired' OR "facility_linked_orders"."fired_at" IS NOT NULL),
	CONSTRAINT "facility_linked_orders_cancelled_check" CHECK ("facility_linked_orders"."status" <> 'cancelled' OR "facility_linked_orders"."cancelled_at" IS NOT NULL),
	CONSTRAINT "facility_linked_orders_refund_check" CHECK ("facility_linked_orders"."refunded_idr" <= "facility_linked_orders"."paid_idr")
);
--> statement-breakpoint
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
--    only once paid. The lookups run in SECURITY DEFINER helpers owned by the
--    migrator (BYPASSRLS, docs/deployment.md; same as ai.custom.sql), so a
--    tenant / outlet scope that hides the order cannot make the check pass.
--    The helper treats an order as breakfast when orders.channel = 'facility'
--    OR a facility_linked_orders row exists, and as unpaid unless that row has
--    paid_at set and status fired. Guards kitchen_tickets (insert or
--    re-pointing order_id) and kitchen_ticket_items (insert or update).
CREATE FUNCTION app.breakfast_order_unpaid(p_tenant uuid, p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT (
           EXISTS (
             SELECT 1 FROM public.orders o
             WHERE o.tenant_id = p_tenant AND o.id = p_order AND o.channel = 'facility'
           )
           OR EXISTS (
             SELECT 1 FROM public.facility_linked_orders f
             WHERE f.tenant_id = p_tenant AND f.order_id = p_order
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.facility_linked_orders f
           WHERE f.tenant_id = p_tenant AND f.order_id = p_order
             AND f.paid_at IS NOT NULL AND f.status = 'fired'
         );
$$;
--> statement-breakpoint
-- The same answer for a kitchen item: the order it names, the order of the
-- order line it points at, and the order of its ticket. Also SECURITY DEFINER
-- so the order_items / kitchen_tickets lookups are not hidden by RLS either.
CREATE FUNCTION app.breakfast_order_item_unpaid(
  p_tenant uuid, p_order uuid, p_order_item uuid, p_ticket uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT app.breakfast_order_unpaid(p_tenant, p_order)
      OR EXISTS (
           SELECT 1 FROM public.order_items i
           WHERE i.tenant_id = p_tenant AND i.id = p_order_item
             AND app.breakfast_order_unpaid(p_tenant, i.order_id)
         )
      OR EXISTS (
           SELECT 1 FROM public.kitchen_tickets t
           WHERE t.tenant_id = p_tenant AND t.id = p_ticket
             AND app.breakfast_order_unpaid(p_tenant, t.order_id)
         );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.breakfast_order_item_unpaid(uuid, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.breakfast_order_unpaid(uuid, uuid) TO legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.breakfast_order_item_unpaid(uuid, uuid, uuid, uuid) TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.kitchen_tickets_breakfast_paid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF app.breakfast_order_unpaid(NEW.tenant_id, NEW.order_id) THEN
    RAISE EXCEPTION 'breakfast order % is not paid and cannot reach the kitchen', NEW.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'kitchen_tickets_breakfast_paid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.kitchen_tickets_breakfast_paid() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "kitchen_tickets_breakfast_paid_trg"
  BEFORE INSERT OR UPDATE OF order_id ON "kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION app.kitchen_tickets_breakfast_paid();
--> statement-breakpoint
CREATE FUNCTION app.kitchen_ticket_items_breakfast_paid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF app.breakfast_order_item_unpaid(NEW.tenant_id, NEW.order_id, NEW.order_item_id, NEW.ticket_id) THEN
    RAISE EXCEPTION 'breakfast order % is not paid and cannot reach the kitchen', NEW.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'kitchen_tickets_breakfast_paid';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.kitchen_ticket_items_breakfast_paid() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "kitchen_ticket_items_breakfast_paid_trg"
  BEFORE INSERT OR UPDATE OF order_id, order_item_id, ticket_id ON "kitchen_ticket_items"
  FOR EACH ROW EXECUTE FUNCTION app.kitchen_ticket_items_breakfast_paid();
