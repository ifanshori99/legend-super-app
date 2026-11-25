-- Hand SQL of the paid WFC tables (brief 1270 W1, migration 0527; PRD v1.7 §3
-- F25/F39, FAC-14). btree_gist comes from 0044.
--
-- A seat cannot be double-booked. Only claims that still occupy the seat count;
-- cancelled / no_show / refunded / completed drop out. The list is
-- WFC_ACTIVE_RESERVATION_STATUSES of @starter/shared/wfc.
ALTER TABLE "wfc_seat_reservations"
  ADD CONSTRAINT "wfc_seat_reservations_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "seat_id" WITH =,
    "slot" WITH &&
  ) WHERE (status IN ('pending_payment','confirmed','checked_in'));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML: a settings version is
-- append-only and a claim or seat (the base of a claim) is never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.wfc_business_settings FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seat_reservations FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seats FROM legend_app;
--> statement-breakpoint
CREATE TRIGGER "wfc_business_settings_append_only_trg"
  BEFORE UPDATE OR DELETE ON "wfc_business_settings"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
-- A settings version carries its own final approval: opened by the WFC module
-- for this very version, same outlet, same two people, decided as approved, and
-- its payload holds every number of the row (camelCase, as in the contract), so
-- nobody approves other numbers than the ones that apply. RLS applies (invoker rights):
-- a request the caller cannot see is refused.
CREATE FUNCTION app.wfc_settings_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  request public.approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM public.approval_requests
    WHERE tenant_id = NEW.tenant_id AND id = NEW.approval_request_id
    FOR SHARE;
  IF NOT FOUND
     OR request.status <> 'approved'
     OR request.level <> request.required_levels
     OR request.source_module <> 'wfc'
     OR request.object_type <> 'wfc_business_settings'
     OR request.object_id <> NEW.id::text
     OR NOT request.payload @> jsonb_build_object(
          'version', NEW.version,
          'effectiveFrom', to_char(NEW.effective_from, 'YYYY-MM-DD'),
          'totalSeats', NEW.total_seats,
          'wfcSeats', NEW.wfc_seats,
          'openHoursPerMonth', NEW.open_hours_per_month,
          'fixedCostIdr', NEW.fixed_cost_idr,
          'targetRevenueIdr', NEW.target_revenue_idr,
          'targetProfitIdr', NEW.target_profit_idr,
          'targetOccupancyBp', NEW.target_occupancy_bp,
          'spendPerPersonIdr', NEW.spend_per_person_idr,
          'cogsBp', NEW.cogs_bp,
          'avgStayMinutes', NEW.avg_stay_minutes,
          'noShowMinutes', NEW.no_show_minutes)
     OR request.outlet_id IS DISTINCT FROM NEW.outlet_id
     OR request.requested_by IS DISTINCT FROM NEW.proposed_by
     OR request.decided_by IS DISTINCT FROM NEW.approved_by THEN
    RAISE EXCEPTION 'wfc settings % need a matching final approval', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "wfc_business_settings_approval_trg"
  BEFORE INSERT ON "wfc_business_settings"
  FOR EACH ROW EXECUTE FUNCTION app.wfc_settings_approval_guard();
--> statement-breakpoint
-- The life of a seat claim. A claim is born pending and unpaid as a copy of its
-- live product on an open seat; the sale values never change; money never goes
-- back; only legal status steps. Paid is proven by the payment link: same
-- outlet, no discount, subtotal = price, paid = total (the total is read, tax is
-- never computed here). A link is never cancelled by a status: cancelling moves
-- `expires_at`, so a link whose expiry is not the one it was attached with
-- cannot confirm the seat; its money may still be recorded, to be refunded.
--
-- A seat that was used or not shown up for (checked_in, no_show, completed) is
-- not refunded, and a confirmed claim is cancelled or refunded only before its
-- slot begins. The one exception is money the provider already gave back on
-- the settling transaction itself: one paid intent of the link (provider
-- reference set, amount at least the link total, no unallocated money on it)
-- whose refunds on that same provider transaction reach the link total. A
-- refund of a double payment, of another intent or spread over intents does
-- not count; those cases go to Finance by hand.
--
-- Lock order: payment link first, then claim (settlement holds the link). An
-- UPDATE already holds the claim, so the link is taken NOWAIT: a caller in the
-- wrong order fails at once (55P03) instead of deadlocking with a settlement.
CREATE FUNCTION app.wfc_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  product public.facility_products%ROWTYPE;
  link public.payment_links%ROWTYPE;
  attached boolean;
  paying boolean;
  confirming boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_payment' OR NEW.paid_idr <> 0 OR NEW.refunded_idr <> 0 THEN
      RAISE EXCEPTION 'wfc claim % must start pending and unpaid', NEW.id
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO product FROM public.facility_products
      WHERE tenant_id = NEW.tenant_id AND outlet_id = NEW.outlet_id
        AND id = NEW.product_id
      FOR SHARE;
    IF NOT FOUND
       OR NOT product.is_active
       OR product.wfc_kind IS DISTINCT FROM NEW.kind
       OR product.wfc_access IS DISTINCT FROM NEW.access
       OR product.seat_fee_idr IS DISTINCT FROM NEW.seat_fee_idr
       OR product.credit_idr IS DISTINCT FROM NEW.credit_idr
       OR product.price_idr IS DISTINCT FROM NEW.price_idr
       OR (product.duration_minutes IS NOT NULL
           AND extract(epoch FROM upper(NEW.slot) - lower(NEW.slot))
             IS DISTINCT FROM (product.duration_minutes * 60)::numeric) THEN
      RAISE EXCEPTION 'wfc claim % does not match its product', NEW.id
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM public.wfc_seats
      WHERE tenant_id = NEW.tenant_id AND outlet_id = NEW.outlet_id
        AND id = NEW.seat_id AND status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wfc claim % needs an active seat', NEW.id
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM public.floor_zones z
      JOIN public.wfc_seats s
        ON s.tenant_id = z.tenant_id AND s.outlet_id = z.outlet_id
        AND s.zone_id = z.id
      WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.seat_id
        AND z.is_wfc AND z.status = 'active'
      FOR SHARE OF z;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wfc claim % needs an open WFC zone', NEW.id
        USING ERRCODE = '23514';
    END IF;
    NEW.payment_link_expires_at := NULL;
    attached := NEW.payment_link_id IS NOT NULL;
    paying := false;
    confirming := false;
  ELSE
    IF (NEW.id, NEW.tenant_id, NEW.outlet_id, NEW.seat_id, NEW.product_id,
        NEW.customer_profile_id, NEW.kind, NEW.access, NEW.business_date,
        NEW.slot, NEW.seat_fee_idr, NEW.credit_idr, NEW.price_idr,
        NEW.settings_version_id, NEW.floor_per_hour_idr, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.outlet_id, OLD.seat_id, OLD.product_id,
        OLD.customer_profile_id, OLD.kind, OLD.access, OLD.business_date,
        OLD.slot, OLD.seat_fee_idr, OLD.credit_idr, OLD.price_idr,
        OLD.settings_version_id, OLD.floor_per_hour_idr, OLD.created_at)
       OR (OLD.payment_link_id IS NOT NULL
           AND NEW.payment_link_id IS DISTINCT FROM OLD.payment_link_id) THEN
      RAISE EXCEPTION 'wfc claim % is a frozen snapshot', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.paid_idr < OLD.paid_idr OR NEW.refunded_idr < OLD.refunded_idr THEN
      RAISE EXCEPTION 'wfc claim % money never goes back', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.paid_idr <> OLD.paid_idr AND NEW.paid_idr <> NEW.price_idr THEN
      RAISE EXCEPTION 'wfc claim % is paid straight to its price', OLD.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (CASE OLD.status
         WHEN 'pending_payment' THEN NEW.status IN ('confirmed', 'cancelled')
         WHEN 'confirmed' THEN NEW.status IN ('checked_in', 'no_show', 'cancelled', 'refunded')
         WHEN 'checked_in' THEN NEW.status IN ('completed', 'refunded')
         WHEN 'completed' THEN NEW.status = 'refunded'
         WHEN 'no_show' THEN NEW.status = 'refunded'
         WHEN 'cancelled' THEN NEW.status = 'refunded'
         ELSE false
       END) THEN
      RAISE EXCEPTION 'wfc claim % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'refunded' AND OLD.status IN ('checked_in', 'no_show', 'completed'))
       OR (NEW.status IN ('cancelled', 'refunded') AND OLD.status = 'confirmed'
           AND clock_timestamp() >= lower(OLD.slot))
       OR (NEW.refunded_idr > OLD.refunded_idr
           AND NOT (NEW.status IN ('cancelled', 'refunded')
                    AND OLD.status IN ('pending_payment', 'confirmed', 'cancelled'))) THEN
      IF NOT EXISTS (
           SELECT 1
             FROM public.payment_links l
             JOIN public.payment_intents i
               ON i.tenant_id = l.tenant_id AND i.outlet_id = l.outlet_id
              AND i.payment_link_id = l.id
            WHERE l.tenant_id = OLD.tenant_id
              AND l.outlet_id = OLD.outlet_id
              AND l.id = OLD.payment_link_id
              AND i.paid_at IS NOT NULL
              AND i.provider_ref IS NOT NULL
              AND i.amount_idr >= l.total_idr
              AND NOT EXISTS (
                    SELECT 1 FROM public.payment_unallocated_funds u
                     WHERE u.tenant_id = i.tenant_id
                       AND u.payment_intent_id = i.id)
              AND (SELECT coalesce(sum(r.amount_idr), 0)
                     FROM public.payment_provider_refunds r
                    WHERE r.tenant_id = i.tenant_id
                      AND r.payment_intent_id = i.id
                      AND r.provider = i.provider
                      AND r.provider_payment_ref = i.provider_ref)
                  >= l.total_idr) THEN
        RAISE EXCEPTION 'wfc claim % is no longer refundable', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
    attached := OLD.payment_link_id IS NULL AND NEW.payment_link_id IS NOT NULL;
    paying := NEW.paid_idr > OLD.paid_idr;
    confirming := NEW.status = 'confirmed' AND OLD.status <> 'confirmed';
    IF attached AND NEW.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'wfc claim % takes a link only while pending', OLD.id
        USING ERRCODE = '23514';
    END IF;
    NEW.payment_link_expires_at := OLD.payment_link_expires_at;
  END IF;

  IF attached OR paying OR confirming THEN
    SELECT * INTO link FROM public.payment_links
      WHERE tenant_id = NEW.tenant_id AND outlet_id = NEW.outlet_id
        AND id = NEW.payment_link_id
      FOR UPDATE NOWAIT;
    IF NOT FOUND
       OR link.discount_idr <> 0
       OR link.subtotal_idr <> NEW.price_idr
       OR link.total_idr <= 0 THEN
      RAISE EXCEPTION 'wfc claim % needs its own link at the full price', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF attached THEN
      IF link.expires_at IS NULL OR link.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'wfc claim % needs an open link', NEW.id
          USING ERRCODE = '23514';
      END IF;
      NEW.payment_link_expires_at := link.expires_at;
    END IF;
    IF (paying OR confirming) AND link.paid_idr <> link.total_idr THEN
      RAISE EXCEPTION 'wfc claim % is not paid in full', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF confirming
       AND link.expires_at IS DISTINCT FROM NEW.payment_link_expires_at THEN
      RAISE EXCEPTION 'wfc claim % link was cancelled', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "wfc_seat_reservations_guard_trg"
  BEFORE INSERT OR UPDATE ON "wfc_seat_reservations"
  FOR EACH ROW EXECUTE FUNCTION app.wfc_claim_guard();
