-- Custom SQL migration file, put your code below! ---
-- legend-4xai (Codex 159): a station's printer_device_id must always point at
-- an active printer of the same tenant and outlet. revokeDevice now clears the
-- binding, but bindings stored earlier (a printer revoked before that fix, or
-- a printer of another outlet/tenant bound before legend-e087) stay. Clear
-- every binding that fails the same rule as assertStationPrinter in
-- menu.service.ts; the station keeps working without a printer and a manager
-- can bind a valid one again. Idempotent.
-- stations and devices are FORCE RLS (devices since 0068) and the migrator
-- is a non-super table owner with no tenant context, so lift FORCE for this
-- transaction only and restore it before commit, as in 0096 (drizzle applies
-- pending migrations in one transaction). Without FORCE the owner skips RLS,
-- so this spans every tenant.
ALTER TABLE public.stations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.devices NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.stations s
SET printer_device_id = NULL, updated_at = now()
WHERE s.printer_device_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.id = s.printer_device_id
      AND d.tenant_id = s.tenant_id
      AND d.outlet_id = s.outlet_id
      AND d.type = 'printer'
      AND d.status = 'active'
      AND d.revoked_at IS NULL
  );
--> statement-breakpoint
ALTER TABLE public.devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stations FORCE ROW LEVEL SECURITY;
