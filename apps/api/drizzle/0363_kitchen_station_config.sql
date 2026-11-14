-- legend-bopi2: KDS station configuration. The station config editor saves the
-- left-to-right tab order (display_order), whether the tab shows
-- (is_active) and the F12 "Fallback Cetak" flag (auto_print_fallback) on the
-- stations row itself. Existing stations keep working: all stay active, no
-- fallback print, and display_order is filled from the order the KDS showed
-- them before (per outlet, by name, then created_at, then id).
-- The stations sync_txid trigger (0262) stamps the rewritten rows, so the
-- catalog down-sync picks the new values up.
ALTER TABLE "stations" ADD COLUMN "display_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "auto_print_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- stations is FORCE RLS and the migrator is a non-super table owner with no
-- tenant context, so lift FORCE for this transaction only and restore it
-- before commit, as in 0150. Without FORCE the owner skips RLS, so the
-- backfill spans every tenant.
ALTER TABLE public.stations NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.stations s
SET display_order = o.rn
FROM (
  SELECT id,
         (row_number() OVER (
           PARTITION BY tenant_id, outlet_id
           ORDER BY name, created_at, id
         ) - 1)::integer AS rn
  FROM public.stations
) o
WHERE o.id = s.id
  AND s.display_order <> o.rn;--> statement-breakpoint
ALTER TABLE public.stations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_display_order_check" CHECK ("stations"."display_order" >= 0);
