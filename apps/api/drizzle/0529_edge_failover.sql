-- 1271 F1 (docs/briefs/1271-edge-failover-cards.md, docs/design/edge-cloud-failover.md):
-- edge -> cloud failover. New table outlet_failover_windows (one open window
-- per outlet, forward-only, never deleted, tenant + outlet RLS); nullable
-- failover_window_id on pos_orders and pos_shifts (composite FK, same outlet,
-- never changed once set); receipt_sequences.series (device | cloud |
-- failover) with the F-prefix reserved for the cloud-only failover run; the
-- pos.failover.manage grant on the stored owner, outlet_manager and supervisor
-- template roles. The manager columns have no FK to "user": the edge copy
-- must apply even when its people snapshot lacks that manager (review P2).
-- No existing order, shift or receipt number changes; only
-- the cloud-owned `C` runs are marked series 'cloud'.
--
-- The migrator may be a plain table owner (contracts.md "Migrations: foreign
-- keys into FORCE RLS tables", pattern 2): lift FORCE on the FORCE tables this
-- file reads, writes or validates a foreign key on, and restore it below.
ALTER TABLE public.receipt_sequences NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_shifts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Preflight (N2): `F<digits>` is reserved for the failover series. A device
-- run already printing under such a prefix cannot be reclassified (its
-- numbers are on paper), so the migration stops for a manual decision.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.receipt_sequences WHERE prefix ~ '^F[0-9]+$') THEN
    RAISE EXCEPTION '1271 F1 preflight: a receipt sequence already uses a reserved F<number> prefix; resolve it before migrating'
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "outlet_failover_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"reason" varchar(500) NOT NULL,
	"override" boolean DEFAULT false NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"activated_by" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edge_heartbeat_at" timestamp with time zone,
	"business_date_from" date NOT NULL,
	"business_date_to" date,
	"return_started_at" timestamp with time zone,
	"return_started_by" text,
	"closing_event_id" uuid,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlet_failover_windows_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "outlet_failover_windows_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "outlet_failover_windows_idempotency_key" UNIQUE("tenant_id","outlet_id","idempotency_key"),
	CONSTRAINT "outlet_failover_windows_status_check" CHECK ("outlet_failover_windows"."status" IN ('active', 'returning', 'closed', 'cancelled')),
	CONSTRAINT "outlet_failover_windows_reason_check" CHECK (char_length(btrim("outlet_failover_windows"."reason")) >= 3),
	CONSTRAINT "outlet_failover_windows_return_check" CHECK (("outlet_failover_windows"."return_started_at" IS NOT NULL) = ("outlet_failover_windows"."status" IN ('returning', 'closed'))),
	CONSTRAINT "outlet_failover_windows_return_by_check" CHECK (("outlet_failover_windows"."return_started_by" IS NOT NULL) = ("outlet_failover_windows"."status" IN ('returning', 'closed'))),
	CONSTRAINT "outlet_failover_windows_cancelled_by_check" CHECK (("outlet_failover_windows"."cancelled_by" IS NOT NULL) = ("outlet_failover_windows"."status" = 'cancelled')),
	CONSTRAINT "outlet_failover_windows_closed_check" CHECK (("outlet_failover_windows"."closed_at" IS NOT NULL) = ("outlet_failover_windows"."status" = 'closed')),
	CONSTRAINT "outlet_failover_windows_cancelled_check" CHECK (("outlet_failover_windows"."cancelled_at" IS NOT NULL) = ("outlet_failover_windows"."status" = 'cancelled')),
	CONSTRAINT "outlet_failover_windows_closing_event_check" CHECK ("outlet_failover_windows"."closing_event_id" IS NULL OR "outlet_failover_windows"."status" <> 'active'),
	CONSTRAINT "outlet_failover_windows_business_dates_check" CHECK (("outlet_failover_windows"."business_date_to" IS NULL) = ("outlet_failover_windows"."status" = 'active')
        AND ("outlet_failover_windows"."business_date_to" IS NULL OR "outlet_failover_windows"."business_date_to" >= "outlet_failover_windows"."business_date_from")),
	CONSTRAINT "outlet_failover_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_windows_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_windows_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "outlet_failover_windows_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "pos_orders" ADD COLUMN "failover_window_id" uuid;
--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "failover_window_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "outlet_failover_windows_open_key" ON "outlet_failover_windows" USING btree ("tenant_id","outlet_id") WHERE "outlet_failover_windows"."status" IN ('active', 'returning');
--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_failover_window_fk" FOREIGN KEY ("tenant_id","outlet_id","failover_window_id") REFERENCES "public"."outlet_failover_windows"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_failover_window_fk" FOREIGN KEY ("tenant_id","outlet_id","failover_window_id") REFERENCES "public"."outlet_failover_windows"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pos_orders_failover_window_idx" ON "pos_orders" USING btree ("tenant_id","failover_window_id") WHERE "pos_orders"."failover_window_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pos_shifts_failover_window_idx" ON "pos_shifts" USING btree ("tenant_id","failover_window_id") WHERE "pos_shifts"."failover_window_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD COLUMN "series" varchar(10) DEFAULT 'device' NOT NULL;
--> statement-breakpoint
-- The cloud-owned run (device key = outlet id, prefix `C`) is the cloud series.
UPDATE public.receipt_sequences SET series = 'cloud'
WHERE device_id = outlet_id AND prefix = 'C';
--> statement-breakpoint
DROP INDEX "receipt_sequences_device_current_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_sequences_device_current_key" ON "receipt_sequences" USING btree ("tenant_id","outlet_id","device_id","series") WHERE "receipt_sequences"."retired_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_series_check" CHECK ("receipt_sequences"."series" IN ('device', 'cloud', 'failover'));
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_failover_prefix_check" CHECK (("receipt_sequences"."series" = 'failover') = ("receipt_sequences"."prefix" ~ '^F[0-9]{1,4}$'));
--> statement-breakpoint
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_failover_cloud_check" CHECK ("receipt_sequences"."series" <> 'failover' OR "receipt_sequences"."edge_node_id" IS NULL);
--> statement-breakpoint
ALTER TABLE public.pos_shifts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receipt_sequences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 1271 F1 failover windows (0529). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like the other edge tables.
SELECT app.enforce_tenant_rls('public.outlet_failover_windows'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.outlet_failover_windows'::regclass);
--> statement-breakpoint
-- A window is never deleted, its identity never changes, its status only moves
-- forward (active -> returning -> closed, active -> cancelled), a set-once
-- field keeps its first value, and a closed or cancelled window is final. The
-- row checks tie the timestamps to the status.
CREATE FUNCTION app.guard_outlet_failover_window() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'failover windows are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'failover window % is final', OLD.id USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.reason <> OLD.reason OR NEW.override <> OLD.override
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.activated_by <> OLD.activated_by
     OR NEW.activated_at <> OLD.activated_at
     OR NEW.edge_heartbeat_at IS DISTINCT FROM OLD.edge_heartbeat_at
     OR NEW.business_date_from <> OLD.business_date_from
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'failover window % identity cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('returning', 'cancelled'))
    OR (OLD.status = 'returning' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'failover window % cannot move from % to %', OLD.id,
      OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF (OLD.business_date_to IS NOT NULL AND NEW.business_date_to IS DISTINCT FROM OLD.business_date_to)
     OR (OLD.return_started_at IS NOT NULL AND NEW.return_started_at IS DISTINCT FROM OLD.return_started_at)
     OR (OLD.return_started_by IS NOT NULL AND NEW.return_started_by IS DISTINCT FROM OLD.return_started_by)
     OR (OLD.closing_event_id IS NOT NULL AND NEW.closing_event_id IS DISTINCT FROM OLD.closing_event_id) THEN
    RAISE EXCEPTION 'failover window % set-once field cannot change', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outlet_failover_windows_guard BEFORE UPDATE OR DELETE ON public.outlet_failover_windows
FOR EACH ROW EXECUTE FUNCTION app.guard_outlet_failover_window();
--> statement-breakpoint
-- A failover order or shift stays one for good, and a normal one never
-- becomes one: failover_window_id is fixed at insert (D1 echo guard).
CREATE FUNCTION app.failover_window_id_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.failover_window_id IS DISTINCT FROM OLD.failover_window_id THEN
    RAISE EXCEPTION '% failover_window_id cannot change', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_orders_failover_window_fixed BEFORE UPDATE OF failover_window_id ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION app.failover_window_id_fixed();
--> statement-breakpoint
CREATE TRIGGER pos_shifts_failover_window_fixed BEFORE UPDATE OF failover_window_id ON public.pos_shifts
FOR EACH ROW EXECUTE FUNCTION app.failover_window_id_fixed();
--> statement-breakpoint
-- 6. 1271 F1 (0529): a run's series never changes (one allocator per series).
CREATE FUNCTION app.receipt_sequences_series_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.series IS DISTINCT FROM OLD.series THEN
    RAISE EXCEPTION 'POS-06: receipt sequence % cannot change its series', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "receipt_sequences_series_fixed_trg"
  BEFORE UPDATE OF series ON "receipt_sequences"
  FOR EACH ROW EXECUTE FUNCTION app.receipt_sequences_series_fixed();
--> statement-breakpoint
-- pos.failover.manage (1271 F1): template rows are copied into a tenant once
-- and never refreshed, so add the code to the stored rows. Same grants as
-- packages/shared/src/access/roles.ts: owner, outlet_manager, supervisor.
-- Every other template and custom roles receive nothing. `roles` has FORCE
-- RLS, so each tenant is named before its rows are touched. Idempotent.
-- Pattern: 0523_period_close_override_grants.sql.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
  grant_row record;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    FOR grant_row IN
      SELECT * FROM (VALUES
        ('owner', 'pos.failover.manage'),
        ('outlet_manager', 'pos.failover.manage'),
        ('supervisor', 'pos.failover.manage')
      ) AS g(template_key, code)
    LOOP
      UPDATE public.roles
      SET permissions = permissions || to_jsonb(grant_row.code),
          updated_at = now()
      WHERE tenant_id = target
        AND is_template
        AND template_key = grant_row.template_key
        AND NOT (permissions ? grant_row.code);
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
