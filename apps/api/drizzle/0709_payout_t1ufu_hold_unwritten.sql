-- 1179 Ronde 3 REVISI (legend-t1ufu, tier K: money). One new append-only table and two
-- function bodies; no row is edited, nobody is paid by it, and the changes only hold a
-- slip back.
-- When the reconciliation cannot write a flag (the write of the flag or of its lock
-- episode is refused), the slip of that flag must stay held without a row in
-- payroll_payout_recon_exceptions. Mapping a slip to an operation through data is not
-- complete and an 'error' observation can stick for ever, so the hold is PER ITEM and
-- is no observation:
-- 1. payroll_payout_recon_unwritten_holds (insert-only): a row per (kind, operation,
--    item) whose flag could not be written, with the payslip of the item. Foreign keys
--    are inside CREATE TABLE.
-- 2. app.payout_recon_hold_unwritten(tenant, kind, operation, items, reason) (new,
--    payout role, legend_payout_recon only like observe_ok, PAYOUT-68 tenant check):
--    inserts one hold row per item, the payslip read from payroll_disbursement_items,
--    with the base reason of the flag (nullable). It writes no observation and takes NO
--    advisory lock of the operation, so a stuck holder of that lock cannot keep the hold
--    from being written. It writes no second row while a hold of the same (kind,
--    operation, item) is not yet taken over by a flag; a later failed write after the
--    takeover makes a new hold (no UNIQUE key: a taken-over hold must not hide it).
-- 3. app.payout_payslip_held_by_recon (0464 body, same signature, owner and ACL): a
--    slip is held when an exception has no approved clearance of its live fingerprint
--    (as before) OR a hold of the slip was not taken over by a flag. A hold is taken
--    over by an exception of the same (kind, operation, item) flagged at or after the
--    hold was made, or by an older exception that no two-person clearance approved
--    before the hold (it holds the slip by itself); an older exception cleared before
--    the hold does not take it over. The reason must match too (the hold's reason is
--    empty, equal, or the exception's reason is the hold's reason with an episode
--    suffix '#n'). From then on the exception and its clearance decide. A good ('ok') read does
--    not release a hold, and there is no other way out.
CREATE TABLE "payroll_payout_recon_unwritten_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"operation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_recon_unwritten_holds_kind_check" CHECK ("payroll_payout_recon_unwritten_holds"."kind" IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw')),
	CONSTRAINT "payroll_payout_recon_unwritten_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_unwritten_holds_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."payroll_disbursement_items"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_recon_unwritten_holds_payslip_fk" FOREIGN KEY ("tenant_id","payslip_id") REFERENCES "public"."payslips"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_unwritten_holds_payslip_idx" ON "payroll_payout_recon_unwritten_holds" USING btree ("tenant_id","payslip_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_recon_unwritten_holds_key_idx" ON "payroll_payout_recon_unwritten_holds" USING btree ("tenant_id","kind","operation_id","item_id");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_recon_unwritten_holds'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML; this table is read-only to it.
REVOKE ALL ON TABLE public.payroll_payout_recon_unwritten_holds FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.payroll_payout_recon_unwritten_holds TO legend_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.payroll_payout_recon_unwritten_holds TO legend_payout;
--> statement-breakpoint
-- A hold is a record that a flag could not be written: never changed, never erased
-- (PAYOUT-87, 23514).
CREATE FUNCTION app.payroll_payout_recon_unwritten_holds_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYOUT-87: a reconciliation hold cannot be changed or erased'
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_unwritten_holds_row_guard_trg
  BEFORE UPDATE OR DELETE ON public.payroll_payout_recon_unwritten_holds
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_recon_unwritten_holds_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_payout_recon_unwritten_holds_truncate_guard_trg
  BEFORE TRUNCATE ON public.payroll_payout_recon_unwritten_holds
  FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_payout_recon_unwritten_holds_guard();
--> statement-breakpoint
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint
CREATE FUNCTION app.payout_recon_hold_unwritten(
  p_tenant uuid, p_kind text, p_operation uuid, p_items uuid[], p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a hold is recorded in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_operation IS NULL OR p_items IS NULL THEN
    RAISE EXCEPTION 'PAYOUT-68: the hold needs a kind, an operation and items'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_recon_unwritten_holds (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, created_at)
  SELECT p_tenant, p_kind, p_operation, i.id, i.payslip_id, p_reason, pg_catalog.clock_timestamp()
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = ANY (p_items)
     AND NOT EXISTS (
       -- A hold of the same kind, operation and item that no flag has taken over yet
       -- already holds the slip: no second row. A hold that a flag took over does NOT
       -- count: a later failed write must hold the slip again.
       SELECT 1
         FROM public.payroll_payout_recon_unwritten_holds h
        WHERE h.tenant_id = p_tenant AND h.kind = p_kind
          AND h.operation_id = p_operation AND h.item_id = i.id
          AND NOT EXISTS (
              SELECT 1
                FROM public.payroll_payout_recon_exceptions e
               WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
                 AND e.operation_id = h.operation_id AND e.item_id = h.item_id
                 AND (h.reason IS NULL OR e.reason = h.reason
                      OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
                 AND (e.flagged_at >= h.created_at
                      OR NOT EXISTS (
                        SELECT 1
                          FROM public.payroll_payout_recon_clearances c
                         WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                           AND c.approved_at IS NOT NULL
                           AND c.approved_at < h.created_at)))
         );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payout_recon_hold_unwritten(uuid, text, uuid, uuid[], text) FROM PUBLIC, legend_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payout_recon_hold_unwritten(uuid, text, uuid, uuid[], text) TO legend_payout_recon;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.payslip_id = p_payslip
       AND NOT EXISTS (
         SELECT 1
           FROM public.payroll_payout_recon_clearances c
          WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
            AND c.approved_at IS NOT NULL
            AND c.flag_sha256 = app.payout_recon_flag_fingerprint(e.tenant_id, e.id)))
  OR EXISTS (
    -- A flag of this slip could not be written (hold_unwritten) and no exception
    -- took the hold over (same kind, operation, item and reason, flagged since or
    -- not cleared before the hold): the slip stays held.
    SELECT 1
      FROM public.payroll_payout_recon_unwritten_holds h
     WHERE h.tenant_id = p_tenant AND h.payslip_id = p_payslip
       AND NOT EXISTS (
            SELECT 1
              FROM public.payroll_payout_recon_exceptions e
             WHERE e.tenant_id = h.tenant_id AND e.kind = h.kind
               AND e.operation_id = h.operation_id AND e.item_id = h.item_id
               AND (h.reason IS NULL OR e.reason = h.reason
                    OR pg_catalog.left(e.reason, pg_catalog.length(h.reason) + 1) = h.reason || '#')
               AND (e.flagged_at >= h.created_at
                    OR NOT EXISTS (
                      SELECT 1
                        FROM public.payroll_payout_recon_clearances c
                       WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                         AND c.approved_at IS NOT NULL
                         AND c.approved_at < h.created_at))))
$$;
