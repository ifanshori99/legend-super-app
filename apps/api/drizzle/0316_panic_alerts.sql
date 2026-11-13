-- FKs are declared inline on these empty new tables so a plain migration owner
-- does not validate them with ALTER TABLE against already FORCE-RLS parents.
CREATE TABLE "panic_alerts" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"unit_id" uuid,
	"first_device_event_id" text NOT NULL,
	"unit_code_snapshot" text NOT NULL,
	"facility_name_snapshot" text NOT NULL,
	"device_label_snapshot" text NOT NULL,
	"kind" text DEFAULT 'press' NOT NULL,
	"triggered_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"press_count" integer DEFAULT 1 NOT NULL,
	"origin" text DEFAULT 'edge' NOT NULL,
	"origin_edge_node_id" uuid,
	"link_offline" boolean DEFAULT false NOT NULL,
	"first_delivered_at" timestamp with time zone,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"unrouted_since" timestamp with time zone,
	"fallback_shown_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"ack_device_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panic_alerts_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "panic_alerts_kind_check" CHECK ("panic_alerts"."kind" IN ('press', 'test')),
	CONSTRAINT "panic_alerts_origin_check" CHECK ("panic_alerts"."origin" IN ('edge', 'cloud')),
	CONSTRAINT "panic_alerts_press_count_check" CHECK ("panic_alerts"."press_count" >= 0),
	CONSTRAINT "panic_alerts_delivered_count_check" CHECK ("panic_alerts"."delivered_count" >= 0),
	CONSTRAINT "panic_alerts_ack_pair_check" CHECK (("panic_alerts"."acknowledged_at" IS NULL) = ("panic_alerts"."acknowledged_by" IS NULL)),
	CONSTRAINT "panic_alerts_resolve_pair_check" CHECK (("panic_alerts"."resolved_at" IS NULL) = ("panic_alerts"."resolved_by" IS NULL)),
	CONSTRAINT "panic_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alerts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_alerts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "panic_press_events" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_event_id" text NOT NULL,
	"alert_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panic_press_events_pkey" PRIMARY KEY("tenant_id","device_id","device_event_id"),
	CONSTRAINT "panic_press_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_press_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_press_events_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_press_events_alert_fk" FOREIGN KEY ("tenant_id","alert_id") REFERENCES "public"."panic_alerts"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "panic_alerts_outlet_received_idx" ON "panic_alerts" USING btree ("tenant_id","outlet_id","received_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "panic_alerts_outlet_open_idx" ON "panic_alerts" USING btree ("tenant_id","outlet_id") WHERE "panic_alerts"."acknowledged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "panic_press_events_alert_idx" ON "panic_press_events" USING btree ("tenant_id","alert_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.panic_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.panic_alerts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.panic_press_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.panic_press_events'::regclass);
--> statement-breakpoint
-- A safety record is never deleted by the application role.
REVOKE DELETE, TRUNCATE ON TABLE public.panic_alerts FROM legend_app;
--> statement-breakpoint
-- Identity, label snapshots and received_at are immutable. Counters, delivery
-- and fallback markers stay writable; acknowledged_* and resolved_* are set
-- once (a repeated identical write is allowed). Everything not listed in
-- `mutable` is immutable, so a new column is immutable until added here.
CREATE FUNCTION app.panic_alert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  mutable text[] := ARRAY[
    'press_count', 'link_offline', 'first_delivered_at', 'delivered_count',
    'unrouted_since', 'fallback_shown_at', 'acknowledged_at', 'acknowledged_by',
    'ack_device_id', 'resolved_at', 'resolved_by', 'resolution_note'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PANIC-ALERT: alerts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'PANIC-ALERT: identity, snapshot and received_at are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (
    NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
    OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by
    OR NEW.ack_device_id IS DISTINCT FROM OLD.ack_device_id
  ) THEN
    RAISE EXCEPTION 'PANIC-ALERT: acknowledgement is set once' USING ERRCODE = '23514';
  END IF;
  IF OLD.resolved_at IS NOT NULL AND (
    NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
    OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
  ) THEN
    RAISE EXCEPTION 'PANIC-ALERT: resolution is set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER panic_alerts_guard_trg BEFORE UPDATE OR DELETE ON public.panic_alerts FOR EACH ROW EXECUTE FUNCTION app.panic_alert_guard();
