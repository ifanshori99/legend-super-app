-- Hand-copied from src/db/schema/delivery.custom.sql (legend-5bn3 D3).
-- delivery_store_index (legend-5bn3 D3): the webhook resolves tenant + outlet
-- from the platform store id BEFORE a tenant context exists (TEN-02). The
-- id-only index has RLS enabled, not forced, and NO policy: the app role can
-- neither read nor write it. The webhook reads exactly one row through the
-- SECURITY DEFINER function app.resolve_delivery_store below; rows are written
-- only by the SECURITY DEFINER trigger below, never by a service.
ALTER TABLE public.delivery_store_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery_store_index FROM legend_app;
--> statement-breakpoint
REVOKE ALL ON public.delivery_store_index FROM PUBLIC;
--> statement-breakpoint
-- Tenant and outlet of one platform store id, or no row. SECURITY DEFINER
-- (owner of the index, which is not FORCED) so the app role never gets SELECT
-- on the table: a caller must already know both the platform and the exact
-- store id, and gets back only that store's tenant and outlet ids.
CREATE OR REPLACE FUNCTION app.resolve_delivery_store(
  p_platform varchar, p_store_external_id varchar
) RETURNS TABLE (tenant_id uuid, outlet_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.tenant_id, i.outlet_id
    FROM public.delivery_store_index i
   WHERE i.platform = p_platform
     AND i.store_external_id = p_store_external_id
   LIMIT 1;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_delivery_store(varchar, varchar) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_delivery_store(varchar, varchar) TO legend_app;
--> statement-breakpoint
-- Keeps the index in step with delivery_channels.store_external_id. SECURITY
-- DEFINER (owner of the index, which is not FORCED) because the app role
-- cannot write the index; it is safe because it only ever copies ids from the
-- channel row being written, and that row already passed the channel's FORCED
-- tenant + outlet RLS. Tenant, outlet, platform and store id all come from the
-- trigger row; nothing is read from the session.
-- BEFORE UPDATE drops the old index row (keyed by OLD: its foreign key names
-- the old store id, so it must go before the channel row changes); AFTER
-- INSERT OR UPDATE adds the new one. Only the triggers call it: EXECUTE is
-- revoked from PUBLIC (trigger functions run without the caller's EXECUTE).
CREATE OR REPLACE FUNCTION app.sync_delivery_store_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    DELETE FROM public.delivery_store_index
     WHERE tenant_id = OLD.tenant_id
       AND outlet_id = OLD.outlet_id
       AND platform = OLD.platform;
  ELSIF NEW.store_external_id IS NOT NULL THEN
    INSERT INTO public.delivery_store_index
      (platform, store_external_id, tenant_id, outlet_id)
    VALUES (NEW.platform, NEW.store_external_id, NEW.tenant_id, NEW.outlet_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.sync_delivery_store_index() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER delivery_channels_store_index_clear
  BEFORE UPDATE OF store_external_id ON public.delivery_channels
  FOR EACH ROW
  WHEN (OLD.store_external_id IS DISTINCT FROM NEW.store_external_id)
  EXECUTE FUNCTION app.sync_delivery_store_index();
--> statement-breakpoint
CREATE TRIGGER delivery_channels_store_index
  AFTER INSERT ON public.delivery_channels
  FOR EACH ROW
  WHEN (NEW.store_external_id IS NOT NULL)
  EXECUTE FUNCTION app.sync_delivery_store_index();
--> statement-breakpoint
CREATE TRIGGER delivery_channels_store_index_set
  AFTER UPDATE OF store_external_id ON public.delivery_channels
  FOR EACH ROW
  WHEN (OLD.store_external_id IS DISTINCT FROM NEW.store_external_id
        AND NEW.store_external_id IS NOT NULL)
  EXECUTE FUNCTION app.sync_delivery_store_index();
--> statement-breakpoint
-- Backfill: channels linked before this migration. The migrator may be a plain
-- table owner (legend-wg5t, see 0070): FORCE is lifted on delivery_channels for
-- this read only and restored before commit (one migration transaction).
ALTER TABLE public.delivery_channels NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.delivery_store_index
  (platform, store_external_id, tenant_id, outlet_id)
SELECT platform, store_external_id, tenant_id, outlet_id
  FROM public.delivery_channels
 WHERE store_external_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.delivery_channels FORCE ROW LEVEL SECURITY;
