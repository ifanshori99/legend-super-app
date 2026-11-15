-- legend-yhia9 C1 (migration 0369): QRIS hold freeze triggers. Append after the
-- generated pos_qris_holds table. The services check the same rules first
-- (QRIS_HOLD_ACTIVE, pos-qris-hold.ts); these triggers are the backstop for any
-- path we forget, including raw SQL and background jobs.

-- 1. The hold itself: only the transitions of the state machine (open ->
--    cancelling | paid | closed, cancelling -> paid | closed); paid and closed
--    are final; the amount, the basis and every reference are immutable; a row
--    is never deleted. While open/cancelling only the poll bookkeeping moves.
CREATE OR REPLACE FUNCTION app.pos_qris_holds_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'QRIS_HOLD_IMMUTABLE: pos_qris_holds rows are never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('paid', 'closed') THEN
    RAISE EXCEPTION 'QRIS_HOLD_IMMUTABLE: hold % is % and final', OLD.id, OLD.state
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.outlet_id IS DISTINCT FROM OLD.outlet_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
    OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
    OR NEW.bill_split_id IS DISTINCT FROM OLD.bill_split_id
    OR NEW.amount_idr IS DISTINCT FROM OLD.amount_idr
    OR NEW.basis_total_idr IS DISTINCT FROM OLD.basis_total_idr
    OR NEW.basis_deposit_idr IS DISTINCT FROM OLD.basis_deposit_idr
    OR NEW.basis_captured_idr IS DISTINCT FROM OLD.basis_captured_idr
    OR NEW.backfilled IS DISTINCT FROM OLD.backfilled
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
  THEN
    RAISE EXCEPTION 'QRIS_HOLD_IMMUTABLE: hold % amount, basis and references are immutable', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'open' AND NEW.state IN ('cancelling', 'paid', 'closed'))
    OR (OLD.state = 'cancelling' AND NEW.state IN ('paid', 'closed'))
  ) THEN
    RAISE EXCEPTION 'QRIS_HOLD_TRANSITION: hold % cannot go from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at
      OR NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by)
    AND NOT (OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'QRIS_HOLD_TRANSITION: hold % cancel request cannot be changed or cleared', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_qris_holds_guard_trg"
  BEFORE UPDATE OR DELETE ON "pos_qris_holds"
  FOR EACH ROW EXECUTE FUNCTION app.pos_qris_holds_guard();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.pos_qris_holds FROM legend_app;
--> statement-breakpoint

-- 2. The bill: while a hold is open/cancelling, no money column, no DP and no
--    move to completed/voided.
CREATE OR REPLACE FUNCTION app.orders_qris_hold_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.subtotal_idr IS DISTINCT FROM OLD.subtotal_idr
      OR NEW.discount_idr IS DISTINCT FROM OLD.discount_idr
      OR NEW.service_charge_idr IS DISTINCT FROM OLD.service_charge_idr
      OR NEW.tax_idr IS DISTINCT FROM OLD.tax_idr
      OR NEW.rounding_idr IS DISTINCT FROM OLD.rounding_idr
      OR NEW.total_idr IS DISTINCT FROM OLD.total_idr
      OR NEW.deposit_applied_idr IS DISTINCT FROM OLD.deposit_applied_idr
      OR (NEW.status IS DISTINCT FROM OLD.status
          AND NEW.status IN ('completed', 'voided')))
    AND EXISTS (
      SELECT 1 FROM public.pos_qris_holds h
      WHERE h.tenant_id = OLD.tenant_id AND h.order_id = OLD.id
        AND h.state IN ('open', 'cancelling')
    )
  THEN
    RAISE EXCEPTION 'QRIS_HOLD_ACTIVE: order % has a QRIS that can still be paid', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "orders_qris_hold_freeze_trg"
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION app.orders_qris_hold_freeze();
--> statement-breakpoint

-- 3. The tenders: while a hold is open/cancelling, no new tender and no change
--    of status, amount or bill (the hold's own tender included; moving a tender
--    to another bill is refused for the bill it leaves and the bill it joins).
--    The apply path sets the hold `paid` first, then captures; the closure path
--    sets the hold `closed` first, then voids.
CREATE OR REPLACE FUNCTION app.pos_order_tenders_qris_hold_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  frozen boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.pos_qris_holds h
      WHERE h.tenant_id = NEW.tenant_id AND h.order_id = NEW.order_id
        AND h.state IN ('open', 'cancelling')
    ) INTO frozen;
  ELSIF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.amount_idr IS DISTINCT FROM OLD.amount_idr
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
  THEN
    SELECT EXISTS (
      SELECT 1 FROM public.pos_qris_holds h
      WHERE h.tenant_id = NEW.tenant_id
        AND h.order_id IN (OLD.order_id, NEW.order_id)
        AND h.state IN ('open', 'cancelling')
    ) INTO frozen;
  ELSE
    frozen := false;
  END IF;
  IF frozen THEN
    RAISE EXCEPTION 'QRIS_HOLD_ACTIVE: order % has a QRIS that can still be paid', NEW.order_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "pos_order_tenders_qris_hold_freeze_trg"
  BEFORE INSERT OR UPDATE ON "pos_order_tenders"
  FOR EACH ROW EXECUTE FUNCTION app.pos_order_tenders_qris_hold_freeze();
--> statement-breakpoint

-- 4. Q93: a manager release of a stuck hold uses its own approval purpose.
ALTER TABLE "pos_order_approval_uses" DROP CONSTRAINT "pos_order_approval_uses_purpose_check";--> statement-breakpoint
ALTER TABLE "pos_order_approval_uses" ADD CONSTRAINT "pos_order_approval_uses_purpose_check" CHECK ("pos_order_approval_uses"."purpose" IN ('order_void', 'item_void', 'discount', 'correction_void', 'refund', 'edc_standalone', 'qris_release'));
