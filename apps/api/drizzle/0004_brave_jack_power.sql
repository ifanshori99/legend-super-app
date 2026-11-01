CREATE TABLE "domain_event_offsets" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"consumer" varchar(255) NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_offsets_tenant_id_consumer_aggregate_type_aggregate_id_pk" PRIMARY KEY("tenant_id","consumer","aggregate_type","aggregate_id")
);
--> statement-breakpoint
CREATE TABLE "domain_event_replays" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid,
	"outbox_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"actor" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_replays_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "domain_event_replays_generation_key" UNIQUE("tenant_id","outbox_id","generation")
);
--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dispatch_state" varchar(20) DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dispatch_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dispatch_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dispatch_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dispatch_job_id" uuid;--> statement-breakpoint
ALTER TABLE "domain_event_outbox" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domain_event_replays" ADD CONSTRAINT "domain_event_replays_tenant_id_outbox_id_domain_event_outbox_tenant_id_id_fk" FOREIGN KEY ("tenant_id","outbox_id") REFERENCES "public"."domain_event_outbox"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.domain_event_outbox ADD CONSTRAINT domain_event_outbox_dispatch_check CHECK ((
  dispatch_generation >= 0 AND
  ((dispatch_state = 'ready' AND dispatch_job_id IS NULL AND dead_lettered_at IS NULL
    AND ((dispatch_lease_token IS NULL AND dispatch_lease_until IS NULL) OR (dispatch_lease_token IS NOT NULL AND dispatch_lease_until IS NOT NULL)))
   OR (dispatch_state = 'queued' AND dispatch_job_id IS NOT NULL AND dead_lettered_at IS NULL AND dispatch_lease_token IS NULL AND dispatch_lease_until IS NULL)
   OR (dispatch_state = 'dead' AND dead_lettered_at IS NOT NULL AND dispatch_lease_token IS NULL AND dispatch_lease_until IS NULL))
) IS TRUE);
--> statement-breakpoint
ALTER TABLE public.domain_event_offsets ADD CONSTRAINT domain_event_offsets_values_check CHECK (
  last_sequence >= 0 AND last_sequence <= 9007199254740991 AND length(consumer) > 0 AND length(aggregate_type) > 0
);
--> statement-breakpoint
ALTER TABLE public.domain_event_replays ADD CONSTRAINT domain_event_replays_values_check CHECK ((
  generation > 0 AND length(btrim(reason)) BETWEEN 1 AND 1000
  AND jsonb_typeof(actor) = 'object' AND actor->>'type' IN ('user', 'ai', 'mcp', 'system')
) IS TRUE);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.domain_event_offsets'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.domain_event_replays'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.domain_event_offsets, public.domain_event_replays FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (last_sequence, updated_at) ON public.domain_event_offsets TO legend_app;
--> statement-breakpoint
CREATE FUNCTION app.wake_outbox_relay() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify('legend_outbox_wakeup', '');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER domain_event_outbox_wakeup AFTER INSERT ON public.domain_event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.wake_outbox_relay();
--> statement-breakpoint
-- A transaction snapshot older than a concurrent inserter cannot see its rows
-- after waiting for the advisory lock. Fail closed outside READ COMMITTED.
CREATE FUNCTION app.enforce_outbox_aggregate_outlet() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Outbox insertion requires READ COMMITTED isolation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.aggregate_type || ':' || NEW.aggregate_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.domain_event_outbox prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.aggregate_type = NEW.aggregate_type
      AND prior.aggregate_id = NEW.aggregate_id
      AND prior.outlet_id IS DISTINCT FROM NEW.outlet_id
  ) THEN
    RAISE EXCEPTION 'Aggregate events must share the same outlet';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER domain_event_outbox_aggregate_outlet BEFORE INSERT ON public.domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION app.enforce_outbox_aggregate_outlet();
