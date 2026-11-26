-- Custom SQL migration file, put your code below! ---
-- Back-office refund payouts of edge sales (1269 E6). Tenant RLS (TEN-01/02)
-- plus the outlet backstop (TEN-03), like edge_edc_ingests.
SELECT app.enforce_tenant_rls('public.pos_refund_payouts'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_refund_payouts'::regclass);
--> statement-breakpoint
-- Money record: never deleted; what the refund pays and to whom never
-- changes; a recorded part is final and a succeeded row is final.
CREATE FUNCTION app.guard_pos_refund_payout() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos refund payouts are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'succeeded'
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.pos_refund_id <> OLD.pos_refund_id
     OR NEW.outlet_id <> OLD.outlet_id OR NEW.order_id <> OLD.order_id
     OR NEW.cash_idr <> OLD.cash_idr OR NEW.edc_idr <> OLD.edc_idr
     OR NEW.event_payload IS DISTINCT FROM OLD.event_payload
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at
     OR (OLD.cash_reference IS NOT NULL AND (
           NEW.cash_reference IS DISTINCT FROM OLD.cash_reference
           OR NEW.cash_channel IS DISTINCT FROM OLD.cash_channel
           OR NEW.cash_settled_by IS DISTINCT FROM OLD.cash_settled_by
           OR NEW.cash_settled_at IS DISTINCT FROM OLD.cash_settled_at))
     OR (OLD.edc_rrn IS NOT NULL AND (
           NEW.edc_rrn IS DISTINCT FROM OLD.edc_rrn
           OR NEW.edc_approval_code IS DISTINCT FROM OLD.edc_approval_code
           OR NEW.edc_settled_by IS DISTINCT FROM OLD.edc_settled_by
           OR NEW.edc_settled_at IS DISTINCT FROM OLD.edc_settled_at)) THEN
    RAISE EXCEPTION 'a recorded pos refund payout is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pos_refund_payouts_guard BEFORE UPDATE OR DELETE ON public.pos_refund_payouts
FOR EACH ROW EXECUTE FUNCTION app.guard_pos_refund_payout();
