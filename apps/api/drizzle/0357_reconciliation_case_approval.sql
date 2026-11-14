-- PAY recon / PRD §3.7: closing a reconciliation case needs an approved chain
-- (matrix action reconciliation_case), never the requester alone. The case
-- gains a `pending_approval` state, the chain it waits on, who asked and who
-- approved. A case with no chain keeps working as before (open/resolved).
ALTER TABLE "payment_reconciliation_cases" DROP CONSTRAINT "payment_reconciliation_cases_status_check";--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD COLUMN "approval_chain_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "payment_reconciliation_cases" ADD CONSTRAINT "payment_reconciliation_cases_status_check" CHECK ("payment_reconciliation_cases"."status" IN ('open','pending_approval','resolved'));--> statement-breakpoint
-- The migrator may also be a plain table owner (no SUPERUSER, no BYPASSRLS):
-- FORCE ROW LEVEL SECURITY would apply the tenant policies to it, and with no
-- app.tenant_id set they raise 42501 on roles and approval_policies. Lift FORCE
-- for this transaction only and restore it before commit, as in 0241.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.approval_policies NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Without a policy the approval service fails closed (APPROVAL_POLICY_MISSING)
-- and no case could ever be closed. Give every tenant that has no
-- reconciliation_case policy the default rows (same as
-- DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES in
-- packages/shared/src/access/approval.ts and seedTenantRoleTemplates): floor 0,
-- level 1, two rows (the Owner and the Finance template roles, either one is
-- enough), distinct actor required. A tenant that already has any
-- reconciliation_case row is never touched; a tenant missing one of the two
-- template roles gets the row of the other. Idempotent.
INSERT INTO public.approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
SELECT r.tenant_id, 'reconciliation_case', 0, r.id, 1, true
FROM public.roles r
WHERE r.is_template
  AND r.template_key IN ('owner', 'finance')
  AND NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.tenant_id = r.tenant_id AND p.action_type = 'reconciliation_case'
  );
--> statement-breakpoint
ALTER TABLE public.approval_policies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
