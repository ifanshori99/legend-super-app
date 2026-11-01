CREATE TABLE "domain_event_consumptions" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"consumer" varchar(255) NOT NULL,
	"event_id" uuid NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_consumptions_tenant_id_consumer_event_id_pk" PRIMARY KEY("tenant_id","consumer","event_id"),
	CONSTRAINT "domain_event_consumptions_aggregate_sequence_key" UNIQUE("tenant_id","consumer","aggregate_type","aggregate_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "domain_event_outbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"event_id" uuid NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event" jsonb NOT NULL,
	"destination" varchar(255) NOT NULL,
	"direction" varchar(20),
	"peer_id" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" varchar(255),
	"lease_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "domain_event_outbox_event_destination_key" UNIQUE("tenant_id","event_id","destination"),
	CONSTRAINT "domain_event_outbox_aggregate_sequence_key" UNIQUE("tenant_id","destination","aggregate_type","aggregate_id","sequence")
);
--> statement-breakpoint
CREATE INDEX "domain_event_outbox_due_idx" ON "domain_event_outbox" USING btree ("tenant_id","status","available_at");
--> statement-breakpoint
ALTER TABLE "domain_event_outbox"
  ADD CONSTRAINT "domain_event_outbox_values_check" CHECK ((
    sequence > 0 AND sequence <= 9007199254740991 AND attempts >= 0
    AND length(destination) > 0 AND length(aggregate_type) > 0
    AND (direction IS NULL AND peer_id IS NULL OR direction IN ('edge_to_cloud', 'cloud_to_edge') AND peer_id IS NOT NULL)
    AND ((status = 'processing' AND lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_until IS NOT NULL AND delivered_at IS NULL)
      OR (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND delivered_at IS NULL)
      OR (status = 'delivered' AND lease_owner IS NULL AND lease_until IS NULL AND delivered_at IS NOT NULL))
    AND event->>'tenantId' = tenant_id::text
    AND event->>'aggregateType' = aggregate_type
    AND event->>'sequence' = sequence::text
    AND event->>'outletId' IS NOT DISTINCT FROM outlet_id::text
  ) IS TRUE);
--> statement-breakpoint
ALTER TABLE "domain_event_consumptions"
  ADD CONSTRAINT "domain_event_consumptions_values_check" CHECK (
    sequence > 0 AND sequence <= 9007199254740991 AND length(consumer) > 0 AND length(aggregate_type) > 0
  );
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.domain_event_outbox'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.domain_event_consumptions'::regclass);
--> statement-breakpoint
CREATE FUNCTION app.prevent_outbox_event_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.id, NEW.outlet_id, NEW.event_id, NEW.aggregate_type,
         NEW.aggregate_id, NEW.sequence, NEW.event, NEW.destination, NEW.direction,
         NEW.peer_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.id, OLD.outlet_id, OLD.event_id, OLD.aggregate_type,
         OLD.aggregate_id, OLD.sequence, OLD.event, OLD.destination, OLD.direction,
         OLD.peer_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Outbox event and destination are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER domain_event_outbox_immutable BEFORE UPDATE ON public.domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION app.prevent_outbox_event_change();
--> statement-breakpoint
REVOKE DELETE ON public.domain_event_outbox, public.domain_event_consumptions FROM legend_app;

--> statement-breakpoint
REVOKE UPDATE ON public.domain_event_consumptions FROM legend_app;
