-- legend-knfl6 (538-G3 slice A): a sale or refund journal of an order carries
-- the order id. A refund journal's source id is the refund id, so nothing
-- linked it to its order: the PBJT report estimated the refund tax base from a
-- period ratio and nothing could cap the refunded tax at what the order
-- collected. The auto-journal consumer now sets order_id (the uuid form of the
-- order ULID) on the journals of order.paid and order.refunded.
-- Nullable, no foreign key (orders live in another module): journals of other
-- sources stay NULL.
--
-- Backfill of journals posted before this column, so a refund already posted
-- counts against its order's cap and the report links it:
--   * a sale journal (source sale, idempotency key aj:sale:<order id>) is the
--     order whose id, as ULID text or uuid text, is its source id;
--   * a refund journal's source id is the refund id: a pos_order_refunds row
--     (POS refund) or an order_issues row (recovery refund); both name their
--     order.
-- Only rows with order_id NULL are set, nothing else changes, a re-run changes
-- nothing. journal_entries rejects UPDATE (ACC-01, trigger
-- journal_entries_append_only): the trigger is disabled for these statements
-- only and enabled again before the end; order_id is a link, no amount, date or
-- account of a posted journal changes. As in 0147, FORCE ROW LEVEL SECURITY is
-- lifted on the touched tables for this transaction and restored (a migrator
-- that is a plain table owner would otherwise hit the tenant policies, 42501).
ALTER TABLE "journal_entries" ADD COLUMN "order_id" uuid;--> statement-breakpoint
CREATE INDEX "journal_entries_order_idx" ON "journal_entries" USING btree ("tenant_id","order_id") WHERE "journal_entries"."order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.journal_entries NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.orders NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.pos_order_refunds NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_issues NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_entries DISABLE TRIGGER journal_entries_append_only;--> statement-breakpoint
UPDATE public.journal_entries e
SET order_id = o.id
FROM public.orders o
WHERE e.order_id IS NULL
  AND e.source_type = 'sale'
  AND e.reversal_of IS NULL
  AND e.tenant_id = o.tenant_id
  AND e.source_id = app.audit_ulid_text(o.id);--> statement-breakpoint
UPDATE public.journal_entries e
SET order_id = o.id
FROM public.orders o
WHERE e.order_id IS NULL
  AND e.source_type = 'sale'
  AND e.reversal_of IS NULL
  AND e.tenant_id = o.tenant_id
  AND lower(e.source_id) = o.id::text;--> statement-breakpoint
UPDATE public.journal_entries e
SET order_id = r.order_id
FROM public.pos_order_refunds r
WHERE e.order_id IS NULL
  AND e.source_type = 'refund'
  AND e.reversal_of IS NULL
  AND e.tenant_id = r.tenant_id
  AND lower(e.source_id) = r.id::text;--> statement-breakpoint
UPDATE public.journal_entries e
SET order_id = i.order_id
FROM public.order_issues i
WHERE e.order_id IS NULL
  AND e.source_type = 'refund'
  AND e.reversal_of IS NULL
  AND e.tenant_id = i.tenant_id
  AND lower(e.source_id) = i.id::text;--> statement-breakpoint
ALTER TABLE public.journal_entries ENABLE TRIGGER journal_entries_append_only;--> statement-breakpoint
ALTER TABLE public.order_issues FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.pos_order_refunds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.journal_entries FORCE ROW LEVEL SECURITY;
