-- 1269 E4 (legend-osqou.25): the ledger of edge EDC transactions mirrored by
-- the cloud. Temporary number 0530 (0529 is 1271 F1); the merge train may
-- renumber. New table only: no existing row changes. Foreign keys are inline
-- in CREATE TABLE (contracts.md legend-m007 pattern 1, as 0528).
CREATE TABLE "edge_edc_ingests" (
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" varchar(10) NOT NULL,
	"reason" text,
	"state_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_edc_ingests_tenant_id_transaction_id_pk" PRIMARY KEY("tenant_id","transaction_id"),
	CONSTRAINT "edge_edc_ingests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_edc_ingests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_edc_ingests_state_check" CHECK ("edge_edc_ingests"."state" IN ('ingested', 'refused')),
	CONSTRAINT "edge_edc_ingests_sequence_check" CHECK ("edge_edc_ingests"."sequence" > 0),
	CONSTRAINT "edge_edc_ingests_hash_check" CHECK (("edge_edc_ingests"."state" = 'ingested') = ("edge_edc_ingests"."state_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "edge_edc_ingests_state_idx" ON "edge_edc_ingests" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
-- Edge EDC ledger mirror (1269 E4). Tenant RLS (TEN-01/02) plus the outlet
-- backstop (TEN-03), like edge_pos_ingests.
SELECT app.enforce_tenant_rls('public.edge_edc_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_edc_ingests'::regclass);
--> statement-breakpoint
-- The ledger is the replay guard of card money: a row is never deleted, its
-- identity never changes, its sequence never goes down and a refused one is
-- final.
CREATE FUNCTION app.guard_edge_edc_ingest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge edc ingests are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'refused' OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.transaction_id <> OLD.transaction_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.sequence < OLD.sequence THEN
    RAISE EXCEPTION 'an edge edc ingest is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_edc_ingests_guard BEFORE UPDATE OR DELETE ON public.edge_edc_ingests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_edc_ingest();
