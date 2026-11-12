-- Define FKs while this new table is empty. Later ADD CONSTRAINT validation
-- would scan FORCE-RLS parents as a plain owner without a tenant context.
CREATE TABLE "loyalty_claim_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid,
	"split_id" uuid,
	"paused_at" timestamp with time zone NOT NULL,
	"remaining_ms" bigint NOT NULL,
	"state" varchar(16) NOT NULL,
	"resume_deadline" timestamp with time zone,
	CONSTRAINT "loyalty_claim_pauses_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "loyalty_claim_pauses_split_key" UNIQUE("tenant_id","split_id"),
	CONSTRAINT "loyalty_claim_pauses_unit_check" CHECK (("loyalty_claim_pauses"."order_id" IS NULL) <> ("loyalty_claim_pauses"."split_id" IS NULL)),
	CONSTRAINT "loyalty_claim_pauses_remaining_check" CHECK ("loyalty_claim_pauses"."remaining_ms" > 0),
	CONSTRAINT "loyalty_claim_pauses_state_check" CHECK ("loyalty_claim_pauses"."state" IN ('busy', 'ambiguous', 'active', 'invalid')),
	CONSTRAINT "loyalty_claim_pauses_resume_check" CHECK (("loyalty_claim_pauses"."state" = 'active') = ("loyalty_claim_pauses"."resume_deadline" IS NOT NULL)),
	CONSTRAINT "loyalty_claim_pauses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "loyalty_claim_pauses_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "loyalty_claim_pauses_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "loyalty_claim_pauses_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "loyalty_claim_pauses_split_fk" FOREIGN KEY ("tenant_id","split_id") REFERENCES "public"."bill_splits"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- Backfill only rights that are still live when this migration starts. The
-- migrator owns these FORCE-RLS tables; temporarily remove FORCE, then restore
-- it inside the migration transaction before installing the new table policy.
ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bill_splits NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_intents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_refunds NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_order_refunds NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH entities AS (
  SELECT o.tenant_id,
    COALESCE(lp.legal_entity_id,
      CASE WHEN count(DISTINCT coalesce(o.legal_entity_id::text, 'NULL')) = 1
                 AND bool_and(o.legal_entity_id IS NOT NULL)
           THEN min(o.legal_entity_id::text)::uuid ELSE NULL END) AS selected_entity
  FROM public.outlets o LEFT JOIN public.loyalty_programs lp ON lp.tenant_id = o.tenant_id
  GROUP BY o.tenant_id, lp.legal_entity_id
), valid_orders AS (
  SELECT o.* FROM public.orders o
  JOIN public.outlets outlet ON outlet.tenant_id = o.tenant_id AND outlet.id = o.outlet_id
  JOIN entities e ON e.tenant_id = o.tenant_id
  WHERE (e.selected_entity IS NULL OR outlet.legal_entity_id IS DISTINCT FROM e.selected_entity)
    AND o.status IN ('sent', 'completed') AND o.customer_profile_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.pos_orders training WHERE training.tenant_id = o.tenant_id AND training.order_id = o.id AND training.is_training)
    AND NOT EXISTS (SELECT 1 FROM public.pos_order_refunds r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id AND r.amount_idr > 0)
    AND NOT EXISTS (SELECT 1 FROM public.payment_intents i
      WHERE i.tenant_id = o.tenant_id
        AND (i.id = o.payment_intent_id OR i.order_id = o.id OR i.bill_split_id IN
          (SELECT s.id FROM public.bill_splits s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id))
        AND (i.status IN ('refunded', 'partially_refunded') OR EXISTS
          (SELECT 1 FROM public.payment_refunds r WHERE r.tenant_id = i.tenant_id AND r.payment_intent_id = i.id AND r.status = 'completed')))
)
INSERT INTO public.loyalty_claim_pauses (tenant_id, outlet_id, order_id, paused_at, remaining_ms, state)
SELECT o.tenant_id, o.outlet_id, o.id, now(), greatest(1, floor(extract(epoch FROM (o.claim_expires_at - now())) * 1000)::bigint), 'ambiguous'
FROM valid_orders o WHERE o.claim_token_hash IS NOT NULL AND o.claim_redeemed_at IS NULL AND o.claim_expires_at > now()
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH entities AS (
  SELECT o.tenant_id,
    COALESCE(lp.legal_entity_id,
      CASE WHEN count(DISTINCT coalesce(o.legal_entity_id::text, 'NULL')) = 1
                 AND bool_and(o.legal_entity_id IS NOT NULL)
           THEN min(o.legal_entity_id::text)::uuid ELSE NULL END) AS selected_entity
  FROM public.outlets o LEFT JOIN public.loyalty_programs lp ON lp.tenant_id = o.tenant_id
  GROUP BY o.tenant_id, lp.legal_entity_id
)
INSERT INTO public.loyalty_claim_pauses (tenant_id, outlet_id, split_id, paused_at, remaining_ms, state)
SELECT s.tenant_id, s.outlet_id, s.id, now(), greatest(1, floor(extract(epoch FROM (s.claim_expires_at - now())) * 1000)::bigint), 'ambiguous'
FROM public.bill_splits s
JOIN public.orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
JOIN public.outlets outlet ON outlet.tenant_id = s.tenant_id AND outlet.id = s.outlet_id
JOIN entities e ON e.tenant_id = s.tenant_id
WHERE (e.selected_entity IS NULL OR outlet.legal_entity_id IS DISTINCT FROM e.selected_entity)
  AND s.status = 'paid' AND s.claim_token_hash IS NOT NULL AND s.claim_redeemed_at IS NULL AND s.claim_expires_at > now()
  AND o.status IN ('awaiting_payment', 'sent', 'completed') AND o.customer_profile_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.pos_orders training WHERE training.tenant_id = o.tenant_id AND training.order_id = o.id AND training.is_training)
  AND NOT EXISTS (SELECT 1 FROM public.pos_order_refunds r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id AND r.amount_idr > 0)
  AND NOT EXISTS (SELECT 1 FROM public.payment_intents i
    WHERE i.tenant_id = o.tenant_id
      AND (i.id = o.payment_intent_id OR i.order_id = o.id OR i.bill_split_id IN
        (SELECT part.id FROM public.bill_splits part WHERE part.tenant_id = o.tenant_id AND part.order_id = o.id))
      AND (i.status IN ('refunded', 'partially_refunded') OR EXISTS
        (SELECT 1 FROM public.payment_refunds r WHERE r.tenant_id = i.tenant_id AND r.payment_intent_id = i.id AND r.status = 'completed')))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_order_refunds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_refunds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_intents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bill_splits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.loyalty_claim_pauses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.loyalty_claim_pauses'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.loyalty_claim_pauses FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (state, resume_deadline, paused_at, remaining_ms) ON public.loyalty_claim_pauses TO legend_app;
