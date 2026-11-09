-- Hand-copied from src/db/schema/delivery.custom.sql (legend-5bn3 D3).
-- delivery_store_index (legend-5bn3 D3): the webhook resolves tenant + outlet
-- from the platform store id BEFORE a tenant context exists (TEN-02), so this
-- id-only index follows the payment_link_tokens pattern (0021_payment_rls):
-- RLS enabled, not forced, open SELECT. The app role gets SELECT only: rows are
-- written by the SECURITY DEFINER trigger below, never by a service.
ALTER TABLE public.delivery_store_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY delivery_store_index_read ON public.delivery_store_index
  AS PERMISSIVE FOR SELECT USING (true);
--> statement-breakpoint
GRANT SELECT ON public.delivery_store_index TO legend_app;
--> statement-breakpoint
-- Keeps the index in step with delivery_channels.store_external_id. SECURITY
-- DEFINER (owner of the index, which is not FORCED) because the app role
-- cannot write the index; it is safe because it only ever copies ids from the
-- channel row being written, and that row already passed the channel's FORCED
-- tenant + outlet RLS. Tenant, outlet, platform and store id all come from NEW;
-- nothing is read from the session.
-- BEFORE UPDATE drops the old index row (its foreign key names the old store
-- id, so it must go before the channel row changes); AFTER INSERT OR UPDATE
-- adds the new one.
CREATE OR REPLACE FUNCTION app.sync_delivery_store_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    DELETE FROM public.delivery_store_index
     WHERE tenant_id = NEW.tenant_id
       AND outlet_id = NEW.outlet_id
       AND platform = NEW.platform;
  ELSIF NEW.store_external_id IS NOT NULL THEN
    INSERT INTO public.delivery_store_index
      (platform, store_external_id, tenant_id, outlet_id)
    VALUES (NEW.platform, NEW.store_external_id, NEW.tenant_id, NEW.outlet_id);
  END IF;
  RETURN NEW;
END;
$$;
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
