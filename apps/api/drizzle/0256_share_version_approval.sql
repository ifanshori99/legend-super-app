ALTER TABLE "share_allocation_versions" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "share_allocation_versions" ADD CONSTRAINT "share_allocation_versions_tenant_id_key" UNIQUE("tenant_id","id");
--> statement-breakpoint
-- Custom SQL (bead legend-3sy9b): share versions go through the approval matrix.
-- The new `id` is the approval objectId and is immutable; a pending version may
-- now be cancelled (its chain expired or was cancelled). Same function as
-- schema/accounting-profit-share.custom.sql (2a).
CREATE OR REPLACE FUNCTION app.share_allocation_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-03: share version % is not a draft and cannot be deleted', OLD.version
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'SH-03: a share version starts as a draft'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.profit_entity_id, NEW.version, NEW.requested_by, NEW.idempotency_key)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.profit_entity_id, OLD.version, OLD.requested_by, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'SH-03: share version identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status = 'draft'
       OR (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'SH-03: share version % is frozen once submitted', OLD.version
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'rejected' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'SH-03: share version cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.effective_from <> OLD.effective_from THEN
    RAISE EXCEPTION 'SH-03: effective date is frozen once submitted'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
