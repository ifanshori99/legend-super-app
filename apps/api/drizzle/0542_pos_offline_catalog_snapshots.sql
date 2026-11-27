-- Review O1 P3 2 (bead legend-wasr7.15): the offline kit snapshot is stored once
-- per (outlet, catalogue version) instead of once per issue. New table
-- pos_offline_catalog_snapshots (append-only, tenant + outlet RLS); a kit names
-- its snapshot through (tenant_id, outlet_id, catalog_version). Kits issued
-- before this migration keep their inline snapshot (never rewritten: kits are
-- append-only); the snapshot column becomes nullable for the kits after it.
-- Existing kits are backfilled into the new table so the foreign key holds.
--
-- The migrator may be a plain table owner (contracts.md "Migrations: foreign
-- keys into FORCE RLS tables", pattern 2): the new foreign key scans
-- pos_offline_kits, so FORCE is lifted and restored below.
ALTER TABLE public.pos_offline_kits NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "pos_offline_catalog_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"catalog_version" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_offline_catalog_snapshots_version_key" UNIQUE("tenant_id","outlet_id","catalog_version"),
	CONSTRAINT "pos_offline_catalog_snapshots_version_check" CHECK ("pos_offline_catalog_snapshots"."catalog_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pos_offline_catalog_snapshots_snapshot_check" CHECK (jsonb_typeof("pos_offline_catalog_snapshots"."snapshot") = 'object'),
	CONSTRAINT "pos_offline_catalog_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_catalog_snapshots_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_offline_catalog_snapshots_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "pos_offline_kits" ALTER COLUMN "snapshot" DROP NOT NULL;
--> statement-breakpoint
-- One snapshot per (outlet, version): the earliest kit's copy (same prices and
-- rules by construction: the version hashes the content; only read stamps may
-- differ).
INSERT INTO public.pos_offline_catalog_snapshots (tenant_id, outlet_id, catalog_version, snapshot, created_at)
SELECT DISTINCT ON (tenant_id, outlet_id, catalog_version)
       tenant_id, outlet_id, catalog_version, snapshot, issued_at
  FROM public.pos_offline_kits
 WHERE snapshot IS NOT NULL
 ORDER BY tenant_id, outlet_id, catalog_version, issued_at, id;
--> statement-breakpoint
ALTER TABLE "pos_offline_kits" ADD CONSTRAINT "pos_offline_kits_snapshot_fk" FOREIGN KEY ("tenant_id","outlet_id","catalog_version") REFERENCES "public"."pos_offline_catalog_snapshots"("tenant_id","outlet_id","catalog_version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.pos_offline_kits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03), like pos_offline_kits.
SELECT app.enforce_tenant_rls('public.pos_offline_catalog_snapshots'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_offline_catalog_snapshots'::regclass);
--> statement-breakpoint
-- What a kit was priced from is never changed or deleted (O2 checks synced
-- sales against it).
CREATE FUNCTION app.guard_pos_offline_catalog_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'POS-06: offline catalogue snapshot % is append-only', OLD.id
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_offline_catalog_snapshots_guard BEFORE UPDATE OR DELETE ON public.pos_offline_catalog_snapshots
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_offline_catalog_snapshot();
