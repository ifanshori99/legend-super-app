-- 1269 E3 (legend-8yqik, legend-k0i8): the ledger of edge shifts and business
-- days mirrored by the cloud, and the late-adjustment dates of an edge sale or
-- void whose own business day was already closed. New table and nullable
-- columns only: no existing row changes.
CREATE TABLE "edge_pos_ingests" (
	"tenant_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"state" varchar(10) NOT NULL,
	"reason" text,
	"business_date" date NOT NULL,
	"late_business_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_pos_ingests_tenant_id_kind_aggregate_id_pk" PRIMARY KEY("tenant_id","kind","aggregate_id"),
	CONSTRAINT "edge_pos_ingests_kind_check" CHECK ("edge_pos_ingests"."kind" IN ('shift', 'day', 'movement')),
	CONSTRAINT "edge_pos_ingests_state_check" CHECK ("edge_pos_ingests"."state" IN ('pending', 'ingested', 'refused')),
	CONSTRAINT "edge_pos_ingests_late_check" CHECK ("edge_pos_ingests"."late_business_date" IS NULL OR "edge_pos_ingests"."late_business_date" > "edge_pos_ingests"."business_date")
);
--> statement-breakpoint
ALTER TABLE "edge_order_ingests" ADD COLUMN "original_business_date" date;--> statement-breakpoint
ALTER TABLE "edge_order_ingests" ADD COLUMN "late_business_date" date;--> statement-breakpoint
ALTER TABLE "edge_order_ingests" ADD COLUMN "late_void_business_date" date;--> statement-breakpoint
ALTER TABLE "edge_pos_ingests" ADD CONSTRAINT "edge_pos_ingests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_pos_ingests" ADD CONSTRAINT "edge_pos_ingests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_pos_ingests_state_idx" ON "edge_pos_ingests" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
ALTER TABLE "edge_order_ingests" ADD CONSTRAINT "edge_order_ingests_late_check" CHECK (("edge_order_ingests"."late_business_date" IS NULL) = ("edge_order_ingests"."original_business_date" IS NULL)
        AND ("edge_order_ingests"."late_business_date" IS NULL OR "edge_order_ingests"."late_business_date" > "edge_order_ingests"."original_business_date")) NOT VALID;--> statement-breakpoint
ALTER TABLE "edge_order_ingests" VALIDATE CONSTRAINT "edge_order_ingests_late_check";--> statement-breakpoint
-- Edge shift and business day ledger (1269 E3). Tenant RLS (TEN-01/02) plus the
-- outlet backstop (TEN-03), like edge_order_ingests.
SELECT app.enforce_tenant_rls('public.edge_pos_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_pos_ingests'::regclass);
--> statement-breakpoint
-- The ledger is the replay guard of drawer money: a row is never deleted, its
-- identity never changes and an ingested one is final.
CREATE FUNCTION app.guard_edge_pos_ingest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge pos ingests are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'ingested' OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.kind <> OLD.kind OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.event_id <> OLD.event_id THEN
    RAISE EXCEPTION 'an edge pos ingest is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_pos_ingests_guard BEFORE UPDATE OR DELETE ON public.edge_pos_ingests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_pos_ingest();
