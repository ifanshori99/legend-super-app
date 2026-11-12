CREATE TABLE "edge_emergency_deliveries" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_emergency_deliveries_tenant_id_incident_id_pk" PRIMARY KEY("tenant_id","incident_id")
);
--> statement-breakpoint
ALTER TABLE "edge_emergency_deliveries" ADD CONSTRAINT "edge_emergency_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_emergency_deliveries" ADD CONSTRAINT "edge_emergency_deliveries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_emergency_deliveries" ADD CONSTRAINT "edge_emergency_deliveries_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."facility_incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_emergency_deliveries'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_emergency_deliveries'::regclass);
--> statement-breakpoint
-- Lock the incident while checking its outlet. The reciprocal trigger blocks
-- moving an incident that already has a delivery row, including races.
CREATE FUNCTION app.guard_edge_emergency_incident_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.facility_incidents
    WHERE tenant_id = NEW.tenant_id AND outlet_id = NEW.outlet_id AND id = NEW.incident_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emergency incident scope mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_emergency_incident_scope BEFORE INSERT OR UPDATE OF tenant_id, outlet_id, incident_id
ON public.edge_emergency_deliveries FOR EACH ROW EXECUTE FUNCTION app.guard_edge_emergency_incident_scope();
--> statement-breakpoint
CREATE FUNCTION app.guard_emergency_incident_move() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.tenant_id, NEW.outlet_id) IS DISTINCT FROM (OLD.tenant_id, OLD.outlet_id)
     AND EXISTS (SELECT 1 FROM public.edge_emergency_deliveries
                 WHERE tenant_id = OLD.tenant_id AND outlet_id = OLD.outlet_id AND incident_id = OLD.id) THEN
    RAISE EXCEPTION 'emergency incident scope is immutable' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER emergency_incident_scope_immutable BEFORE UPDATE OF tenant_id, outlet_id
ON public.facility_incidents FOR EACH ROW EXECUTE FUNCTION app.guard_emergency_incident_move();
