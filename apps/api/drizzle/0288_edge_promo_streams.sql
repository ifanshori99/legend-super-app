ALTER TABLE "promo_settings" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "sync_txid" bigint DEFAULT (pg_current_xact_id()::text)::bigint NOT NULL;--> statement-breakpoint
CREATE INDEX "promotions_sync_txid_idx" ON "promotions" USING btree ("tenant_id","sync_txid","id");--> statement-breakpoint
CREATE INDEX "vouchers_sync_txid_idx" ON "vouchers" USING btree ("tenant_id","sync_txid","id");
--> statement-breakpoint

-- Promotion rules are cloud-versioned; local money counters do not advance the
-- rule stamp, so an offline sale cannot prevent a later cloud revocation.
CREATE OR REPLACE FUNCTION app.set_promotion_sync_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.sync_txid := pg_catalog.pg_current_xact_id()::text::bigint;
  ELSIF NEW.sync_txid IS DISTINCT FROM OLD.sync_txid OR
        (to_jsonb(NEW) - ARRAY['sync_txid', 'uses_total', 'spent_idr', 'updated_at'])
          IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['sync_txid', 'uses_total', 'spent_idr', 'updated_at']) THEN
    NEW.sync_txid := pg_catalog.pg_current_xact_id()::text::bigint;
  ELSE
    NEW.sync_txid := OLD.sync_txid;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER promotions_set_sync_txid BEFORE INSERT OR UPDATE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION app.set_promotion_sync_txid();
--> statement-breakpoint
CREATE TRIGGER vouchers_set_sync_txid BEFORE INSERT OR UPDATE ON "vouchers"
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
CREATE TRIGGER promo_settings_set_sync_txid BEFORE INSERT OR UPDATE ON "promo_settings"
FOR EACH ROW EXECUTE FUNCTION app.set_sync_txid();
--> statement-breakpoint
-- Outlet switches are part of the parent promotion document. The explicit
-- stamp also forces the rule-only trigger above to retain this new version.
CREATE OR REPLACE FUNCTION app.touch_promotion_sync_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.promotions SET sync_txid = pg_catalog.pg_current_xact_id()::text::bigint,
      updated_at = now()
      WHERE tenant_id = OLD.tenant_id AND id = OLD.promotion_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE public.promotions SET sync_txid = pg_catalog.pg_current_xact_id()::text::bigint,
      updated_at = now()
      WHERE tenant_id = NEW.tenant_id AND id = NEW.promotion_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER promotion_outlets_touch_sync_parent
AFTER INSERT OR UPDATE OR DELETE ON "promotion_outlets"
FOR EACH ROW EXECUTE FUNCTION app.touch_promotion_sync_parent();
--> statement-breakpoint
-- A policy change, including deletion, must resend every tenant rule. Policy
-- has its own version because pages for different promotions may arrive late.
CREATE OR REPLACE FUNCTION app.touch_promotion_settings_sync_parents() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('legend.skip_sync_txid', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.promotions SET sync_txid = pg_catalog.pg_current_xact_id()::text::bigint,
      updated_at = now() WHERE tenant_id = OLD.tenant_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE public.promotions SET sync_txid = pg_catalog.pg_current_xact_id()::text::bigint,
      updated_at = now() WHERE tenant_id = NEW.tenant_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER promo_settings_touch_sync_parents
AFTER INSERT OR UPDATE OR DELETE ON "promo_settings"
FOR EACH ROW EXECUTE FUNCTION app.touch_promotion_settings_sync_parents();
