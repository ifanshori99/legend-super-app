-- legend-yhia9 C1: QRIS hold table. FKs are inline on this empty new table so a
-- plain migration owner does not validate them with ALTER TABLE against
-- already FORCE-RLS parents (same as 0305).
CREATE TABLE "pos_qris_holds" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"tender_id" uuid,
	"payment_intent_id" uuid NOT NULL,
	"bill_split_id" uuid,
	"amount_idr" bigint NOT NULL,
	"basis_total_idr" bigint,
	"basis_deposit_idr" bigint,
	"basis_captured_idr" bigint,
	"backfilled" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" text,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" text,
	"last_checked_at" timestamp with time zone,
	"check_attempts" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"close_evidence" jsonb,
	CONSTRAINT "pos_qris_holds_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "pos_qris_holds_intent_key" UNIQUE("tenant_id","payment_intent_id"),
	CONSTRAINT "pos_qris_holds_tender_key" UNIQUE("tenant_id","tender_id"),
	CONSTRAINT "pos_qris_holds_amount_check" CHECK ("pos_qris_holds"."amount_idr" > 0),
	CONSTRAINT "pos_qris_holds_target_check" CHECK ("pos_qris_holds"."tender_id" IS NOT NULL OR "pos_qris_holds"."bill_split_id" IS NOT NULL OR "pos_qris_holds"."opened_by" IS NULL),
	CONSTRAINT "pos_qris_holds_state_check" CHECK ("pos_qris_holds"."state" IN ('open', 'cancelling', 'paid', 'closed')),
	CONSTRAINT "pos_qris_holds_basis_check" CHECK ("pos_qris_holds"."backfilled" OR "pos_qris_holds"."tender_id" IS NULL OR ("pos_qris_holds"."basis_total_idr" IS NOT NULL AND "pos_qris_holds"."basis_deposit_idr" IS NOT NULL AND "pos_qris_holds"."basis_captured_idr" IS NOT NULL AND "pos_qris_holds"."amount_idr" = "pos_qris_holds"."basis_total_idr" - "pos_qris_holds"."basis_deposit_idr" - "pos_qris_holds"."basis_captured_idr")),
	CONSTRAINT "pos_qris_holds_cancel_pair_check" CHECK (("pos_qris_holds"."cancel_requested_at" IS NULL) = ("pos_qris_holds"."cancel_requested_by" IS NULL)),
	CONSTRAINT "pos_qris_holds_closed_check" CHECK (("pos_qris_holds"."state" IN ('open', 'cancelling')) = ("pos_qris_holds"."closed_at" IS NULL)),
	CONSTRAINT "pos_qris_holds_close_reason_check" CHECK (("pos_qris_holds"."close_reason" IS NULL OR "pos_qris_holds"."close_reason" IN ('provider_paid', 'provider_expired', 'provider_failed', 'provider_cancelled', 'force_released')) AND (("pos_qris_holds"."state" IN ('paid', 'closed')) = ("pos_qris_holds"."close_reason" IS NOT NULL)))
,
	CONSTRAINT "pos_qris_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_cancel_requested_by_user_id_fk" FOREIGN KEY ("cancel_requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_tender_fk" FOREIGN KEY ("tenant_id","tender_id") REFERENCES "public"."pos_order_tenders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_bill_split_fk" FOREIGN KEY ("tenant_id","bill_split_id") REFERENCES "public"."bill_splits"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_qris_holds_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_qris_holds_active_order_key" ON "pos_qris_holds" USING btree ("tenant_id","order_id") WHERE "pos_qris_holds"."state" IN ('open', 'cancelling') AND NOT "pos_qris_holds"."backfilled";
--> statement-breakpoint
CREATE INDEX "pos_qris_holds_due_idx" ON "pos_qris_holds" USING btree ("state","next_check_at") WHERE "pos_qris_holds"."state" IN ('open', 'cancelling');
--> statement-breakpoint
-- Backfill (design §5): every QRIS tender still waiting for its money gets one
-- `open` hold (backfilled, basis NULL, amount from the tender) so the bill is
-- frozen and the hold check job resolves it from the provider
-- (next_check_at = now()). A guest split-bill QR (a payment intent with
-- bill_split_id, still pending) gets the same, with bill_split_id set and no
-- tender. One bill with more than one collectible QR (POS tender and guest
-- intent together) cannot be frozen safely: the migration fails. The migrator may be a plain table owner (no
-- BYPASSRLS): lift FORCE on the source tables for this transaction only and
-- restore it right after (same pattern as 0286, 0292).
ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_order_tenders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_intents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bill_splits NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(d.order_id::text || ' (' || d.n || ' QRs)', ', ') INTO dup
  FROM (
    SELECT q.tenant_id, q.order_id, count(*) AS n
    FROM (
      SELECT t.tenant_id, t.order_id
      FROM public.pos_order_tenders t
      JOIN public.payment_intents i
        ON i.tenant_id = t.tenant_id AND i.id = t.payment_intent_id
      WHERE t.method = 'qris' AND t.status = 'authorized'
        AND t.payment_link_id IS NOT NULL AND i.status <> 'paid'
      UNION ALL
      SELECT bs.tenant_id, bs.order_id
      FROM public.payment_intents i
      JOIN public.bill_splits bs
        ON bs.tenant_id = i.tenant_id AND bs.id = i.bill_split_id
      WHERE i.bill_split_id IS NOT NULL AND i.method = 'qris'
        AND i.status = 'pending' AND i.provider_ref IS NOT NULL
    ) q
    GROUP BY q.tenant_id, q.order_id
    HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'QRIS hold backfill: more than one collectible QRIS on bill(s) %; resolve them before migrating', dup;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
SELECT t.tenant_id, gen_random_uuid(), t.outlet_id, t.order_id, t.id,
       t.payment_intent_id, t.amount_idr, true, 'open', t.requested_at,
       coalesce(po.cashier_id, t.captured_by), now()
FROM public.pos_order_tenders t
JOIN public.payment_intents i
  ON i.tenant_id = t.tenant_id AND i.id = t.payment_intent_id
JOIN public.pos_orders po
  ON po.tenant_id = t.tenant_id AND po.order_id = t.order_id
WHERE t.method = 'qris' AND t.status = 'authorized'
  AND t.payment_link_id IS NOT NULL AND i.status <> 'paid';
--> statement-breakpoint
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   bill_split_id, amount_idr, backfilled, state, opened_at, opened_by,
   next_check_at)
SELECT i.tenant_id, gen_random_uuid(), i.outlet_id, bs.order_id, NULL,
       i.id, i.bill_split_id, i.amount_idr, true, 'open', i.created_at,
       NULL, now()
FROM public.payment_intents i
JOIN public.bill_splits bs
  ON bs.tenant_id = i.tenant_id AND bs.id = i.bill_split_id
WHERE i.bill_split_id IS NOT NULL AND i.method = 'qris'
  AND i.status = 'pending' AND i.provider_ref IS NOT NULL;
--> statement-breakpoint
-- Ambiguous history (so-879 ota0l): a provider code the system stopped
-- collecting locally is not proof the provider stopped. For a bill that is not
-- final yet, every QRIS code with a provider_ref and no proof of payment that
-- (a) belongs to a POS QRIS tender voided or failed locally, or (b) is an
-- expired/superseded guest split-part code, (c) is a guest order-wide code
-- (pending, expired or superseded) or (d) a sibling code of a POS tender's
-- link, gets its own open backfilled hold (one per payment intent; the per-bill
-- unique index only counts non-backfilled holds). The hold check job closes
-- each one only on provider proof. Final bills are skipped (a late payment
-- there is refunded as unallocated funds). The one-collectible-QR guard above
-- is not widened.
-- so-885 legend-0owye: a `failed` intent is not proof either. On m1 an amount
-- mismatch (Duitku) marks the intent `failed` AND parks the paid money in
-- payment_unallocated_funds. Such an intent with an UNRESOLVED fund (no refund
-- or credit yet) is held in every shape below (tender, split part, whole
-- order, sibling code), so the guest is not asked to pay the bill again before
-- the parked money is returned. The hold check job ends it once every fund of
-- the intent is resolved; a failed intent without an open fund stays unheld.
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
SELECT t.tenant_id, gen_random_uuid(), t.outlet_id, t.order_id, t.id,
       t.payment_intent_id, t.amount_idr, true, 'open', t.requested_at,
       coalesce(po.cashier_id, t.captured_by), now()
FROM public.pos_order_tenders t
JOIN public.payment_intents i
  ON i.tenant_id = t.tenant_id AND i.id = t.payment_intent_id
JOIN public.pos_orders po
  ON po.tenant_id = t.tenant_id AND po.order_id = t.order_id
JOIN public.orders o
  ON o.tenant_id = t.tenant_id AND o.id = t.order_id
WHERE t.method = 'qris' AND t.status IN ('voided', 'failed')
  AND t.payment_link_id IS NOT NULL
  AND i.method = 'qris' AND i.provider_ref IS NOT NULL
  AND (i.status IN ('pending', 'expired')
    OR (i.status = 'failed' AND EXISTS (
    SELECT 1 FROM public.payment_unallocated_funds f
    WHERE f.tenant_id = i.tenant_id AND f.payment_intent_id = i.id
      AND f.resolved_at IS NULL)))
  AND o.status NOT IN ('completed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_qris_holds h
    WHERE h.tenant_id = i.tenant_id
      AND (h.payment_intent_id = i.id OR h.tender_id = t.id));
--> statement-breakpoint
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   bill_split_id, amount_idr, backfilled, state, opened_at, opened_by,
   next_check_at)
SELECT i.tenant_id, gen_random_uuid(), i.outlet_id, bs.order_id, NULL,
       i.id, i.bill_split_id, i.amount_idr, true, 'open', i.created_at,
       NULL, now()
FROM public.payment_intents i
JOIN public.bill_splits bs
  ON bs.tenant_id = i.tenant_id AND bs.id = i.bill_split_id
JOIN public.orders o
  ON o.tenant_id = bs.tenant_id AND o.id = bs.order_id
WHERE i.bill_split_id IS NOT NULL AND i.method = 'qris'
  AND (i.status = 'expired'
    OR (i.status = 'failed' AND EXISTS (
    SELECT 1 FROM public.payment_unallocated_funds f
    WHERE f.tenant_id = i.tenant_id AND f.payment_intent_id = i.id
      AND f.resolved_at IS NULL)))
  AND i.provider_ref IS NOT NULL
  AND o.status NOT IN ('completed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_qris_holds h
    WHERE h.tenant_id = i.tenant_id AND h.payment_intent_id = i.id);
--> statement-breakpoint
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
SELECT i.tenant_id, gen_random_uuid(), i.outlet_id, o.id, NULL, i.id,
       i.amount_idr, true, 'open', i.created_at, NULL, now()
FROM public.payment_intents i
JOIN public.orders o
  ON o.tenant_id = i.tenant_id AND o.payment_link_id = i.payment_link_id
WHERE i.bill_split_id IS NULL AND i.method = 'qris'
  AND (i.status IN ('pending', 'expired')
    OR (i.status = 'failed' AND EXISTS (
    SELECT 1 FROM public.payment_unallocated_funds f
    WHERE f.tenant_id = i.tenant_id AND f.payment_intent_id = i.id
      AND f.resolved_at IS NULL)))
  AND i.provider_ref IS NOT NULL
  AND o.status NOT IN ('completed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_order_tenders t
    WHERE t.tenant_id = i.tenant_id AND t.payment_intent_id = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_qris_holds h
    WHERE h.tenant_id = i.tenant_id AND h.payment_intent_id = i.id);
--> statement-breakpoint
INSERT INTO public.pos_qris_holds
  (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
   amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
SELECT i.tenant_id, gen_random_uuid(), i.outlet_id, t.order_id, NULL, i.id,
       i.amount_idr, true, 'open', i.created_at, NULL, now()
FROM public.pos_order_tenders t
JOIN public.payment_intents i
  ON i.tenant_id = t.tenant_id AND i.payment_link_id = t.payment_link_id
JOIN public.orders o
  ON o.tenant_id = t.tenant_id AND o.id = t.order_id
WHERE t.method = 'qris' AND t.payment_link_id IS NOT NULL
  AND i.id <> coalesce(t.payment_intent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  AND i.bill_split_id IS NULL AND i.method = 'qris'
  AND (i.status IN ('pending', 'expired')
    OR (i.status = 'failed' AND EXISTS (
    SELECT 1 FROM public.payment_unallocated_funds f
    WHERE f.tenant_id = i.tenant_id AND f.payment_intent_id = i.id
      AND f.resolved_at IS NULL)))
  AND i.provider_ref IS NOT NULL
  AND o.status NOT IN ('completed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_order_tenders t2
    WHERE t2.tenant_id = i.tenant_id AND t2.payment_intent_id = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.pos_qris_holds h
    WHERE h.tenant_id = i.tenant_id AND h.payment_intent_id = i.id);
--> statement-breakpoint
ALTER TABLE public.bill_splits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_intents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_order_tenders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_qris_holds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_qris_holds'::regclass);
