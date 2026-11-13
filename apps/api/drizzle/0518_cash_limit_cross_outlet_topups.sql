-- Cash limit and anti-split across outlets (founder Q18, 13 Nov 2026). The
-- creator's direct petty cash top-ups of the day are summed over ALL outlets,
-- but `petty_cash_entries` has outlet RLS: a creator whose outlet scope is
-- narrower than the top-ups they made would not see the others and the sum
-- would fall short. This narrow SECURITY DEFINER function returns only the
-- amount and time of one creator's direct top-ups of the current tenant (the
-- tenant comes from app.tenant_id, never from an argument), excluding the
-- ledger row an approved top-up produces (idempotency key `pt/<entryId>`,
-- counted from its cash_bank_entries row). Nothing is written. search_path is
-- pinned; EXECUTE is limited to legend_app.
CREATE FUNCTION app.cash_limit_direct_topups(p_actor text, p_since timestamptz)
RETURNS TABLE (amount_idr bigint, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.amount_idr, p.created_at
  FROM public.petty_cash_entries p
  WHERE p.tenant_id = app.require_tenant_id()
    AND p.created_by = p_actor
    AND p.kind = 'topup'
    AND p.idempotency_key NOT LIKE 'pt/%'
    AND p.created_at >= p_since
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.cash_limit_direct_topups(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.cash_limit_direct_topups(text, timestamptz) TO legend_app;
