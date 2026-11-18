-- legend-snwnn (1005): the nightly reconciliation may flag a return withdrawal.
-- app.payout_recon_flag (0584 body, signature and ACL unchanged): the accepted
-- kinds also contain return_withdraw (0472 added it to the exception CHECK). The
-- flag fingerprint of 0584 (the item, the attestations of the operation, the
-- postings of the item) fits a withdrawal as it is: the operation is the
-- withdrawal id and the item is one of the claim's items; nothing to change.
-- Ownership: as 0581, replaced by the payout role itself.
GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO legend_payout;
--> statement-breakpoint
SET ROLE legend_payout;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.payout_recon_flag(
  p_tenant uuid, p_kind text, p_operation uuid, p_item uuid, p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_payslip uuid;
  v_exception uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM app.require_tenant_id() THEN
    RAISE EXCEPTION 'PAYOUT-68: a flag is raised in the tenant in force only'
      USING ERRCODE = '23514';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('correction', 'overpaid', 'return', 'posting_source', 'closure', 'resolve', 'bank_confirm', 'batch_approve', 'return_withdraw')
    OR p_operation IS NULL OR p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'PAYOUT-68: the flag needs a kind, an operation and a reason'
      USING ERRCODE = '23514';
  END IF;
  SELECT i.payslip_id INTO v_payslip
    FROM public.payroll_disbursement_items i
   WHERE i.tenant_id = p_tenant AND i.id = p_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT-68: the flagged item is not an item of the tenant'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.payroll_payout_recon_exceptions (
    tenant_id, kind, operation_id, item_id, payslip_id, reason, flagged_at)
  VALUES (
    p_tenant, p_kind, p_operation, p_item, v_payslip,
    pg_catalog.left(p_reason, 200), pg_catalog.statement_timestamp())
  ON CONFLICT ON CONSTRAINT payroll_payout_recon_exceptions_flag_key DO NOTHING
  RETURNING id INTO v_exception;
  IF v_exception IS NULL THEN
    SELECT e.id INTO v_exception
      FROM public.payroll_payout_recon_exceptions e
     WHERE e.tenant_id = p_tenant AND e.kind = p_kind AND e.operation_id = p_operation
       AND e.item_id = p_item AND e.reason = pg_catalog.left(p_reason, 200);
  END IF;
  PERFORM app.payout_recon_flag_see(p_tenant, v_exception);
END $$;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM legend_payout;
--> statement-breakpoint
REVOKE SET OPTION FOR legend_payout FROM CURRENT_USER;
