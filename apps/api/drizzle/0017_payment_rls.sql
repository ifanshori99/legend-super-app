-- Payment isolation (bead legend-gz3; PRD v1.7 §3.13, §6 D payment_intents /
-- unallocated_funds, TEN-01/TEN-03).
--
-- Every payment table is tenant-owned: tenant_id NOT NULL with the restrictive
-- tenant_isolation policy from app.enforce_tenant_rls, plus DML grants to the
-- non-bypass application role. The composite (tenant_id, ...) foreign keys in
-- 0016 already stop a privileged writer from pointing an intent, a link or an
-- unallocated row at another tenant's row.
--
-- payment_link_tokens is the guest credential index read BEFORE a tenant
-- context exists (TEN-02): the guest only holds the token. It stores a SHA-256
-- hash and ids, never an amount or guest data, so SELECT stays open like
-- tenant_domains while writes are tenant-checked. RLS is ENABLE (not FORCE) so
-- the migration owner can still audit/repair the index.
--
-- Run order: after the generated tables migration (0016). Never replay the
-- 119connect migrations; this is the Legend policy.
SELECT app.enforce_tenant_rls('public.payment_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_intents'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_routing_rules'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_unallocated_funds'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payment_evidence'::regclass);
--> statement-breakpoint
ALTER TABLE public.payment_link_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_link_tokens_read ON public.payment_link_tokens
  AS PERMISSIVE FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY payment_link_tokens_insert ON public.payment_link_tokens
  AS PERMISSIVE FOR INSERT WITH CHECK (tenant_id = app.require_tenant_id());
--> statement-breakpoint
CREATE POLICY payment_link_tokens_update ON public.payment_link_tokens
  AS PERMISSIVE FOR UPDATE
  USING (tenant_id = app.require_tenant_id())
  WITH CHECK (tenant_id = app.require_tenant_id());
--> statement-breakpoint
CREATE POLICY payment_link_tokens_delete ON public.payment_link_tokens
  AS PERMISSIVE FOR DELETE USING (tenant_id = app.require_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_link_tokens TO legend_app;
