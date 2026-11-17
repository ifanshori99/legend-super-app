-- Define the FK while this new table is empty (see 0556).
CREATE TABLE "payroll_overtime_correction_activations" (
	"tenant_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_overtime_correction_activations_pkey" PRIMARY KEY("tenant_id"),
	CONSTRAINT "payroll_overtime_correction_activations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- legend-72nod (architect R1): the overtime correction starts here. Every
-- tenant that already has a payroll run gets one row stamped now; a run locked
-- before it is never a source of a correction (its overtime was settled by the
-- old process). A tenant without a row has every run eligible. Backfill only:
-- the row is read-only for the app, never imported. FORCE RLS on payroll_runs
-- is lifted for the one read (the migration role has no tenant context) and
-- restored; the new table gets its RLS after the insert.
ALTER TABLE public.payroll_runs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.payroll_overtime_correction_activations (tenant_id)
  SELECT DISTINCT r.tenant_id FROM public.payroll_runs r
  ON CONFLICT (tenant_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.payroll_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_overtime_correction_activations'::regclass);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payroll_overtime_correction_activations FROM legend_app;
