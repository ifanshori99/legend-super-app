-- TEN-03 outlet isolation at the database (bead legend-tjey, decision in
-- docs/plan/contracts.md "TEN-03 outlet isolation layers").
--
-- `withTenant` installs app.outlet_ids per transaction from the server-minted
-- ScopedTenantContext: '*' for a tenant-wide scope, otherwise a JSON array of
-- outlet uuids. These functions turn that setting into a RESTRICTIVE policy on
-- every outlet-owned table (outlet_id UUID NOT NULL), on top of the tenant
-- policy. Semantics are explicit and fail closed:
--   unset / ''          -> error 42501 (no outlet context, like app.tenant_id)
--   '*'                 -> every outlet of the current tenant
--   '["<uuid>", ...]'   -> exactly those outlets; '[]' -> no rows
--   anything else       -> error (malformed JSON, non-array, non-uuid element)

-- True only for the explicit tenant-wide wildcard; raises when the outlet
-- context is missing or malformed so a policy can never default to "all".
CREATE FUNCTION app.outlet_scope_is_tenant() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE scope text;
BEGIN
  scope := current_setting('app.outlet_ids', true);
  IF scope IS NULL OR scope = '' THEN
    RAISE EXCEPTION 'outlet scope context is required' USING ERRCODE = '42501';
  END IF;
  IF scope = '*' THEN
    RETURN true;
  END IF;
  PERFORM app.scoped_outlet_ids();
  RETURN false;
END $$;
--> statement-breakpoint
-- The outlets of an explicit scope ('{}' for the wildcard, which
-- outlet_scope_is_tenant() answers). Raises on a missing or malformed scope.
CREATE FUNCTION app.scoped_outlet_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  scope text;
  parsed jsonb;
BEGIN
  scope := current_setting('app.outlet_ids', true);
  IF scope IS NULL OR scope = '' THEN
    RAISE EXCEPTION 'outlet scope context is required' USING ERRCODE = '42501';
  END IF;
  IF scope = '*' THEN
    RETURN '{}'::uuid[];
  END IF;
  BEGIN
    parsed := scope::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'outlet scope context is malformed' USING ERRCODE = '42501';
  END;
  IF jsonb_typeof(parsed) <> 'array' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(parsed) AS element
    WHERE jsonb_typeof(element) <> 'string'
  ) THEN
    RAISE EXCEPTION 'outlet scope context is malformed' USING ERRCODE = '42501';
  END IF;
  BEGIN
    RETURN ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(parsed) AS value);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'outlet scope context is malformed' USING ERRCODE = '42501';
  END;
END $$;
--> statement-breakpoint
-- Call from each outlet-owned table migration after app.enforce_tenant_rls.
-- The outlet policy narrows the tenant policy; it never replaces it.
CREATE FUNCTION app.enforce_outlet_rls(target regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = target AND attname = 'outlet_id' AND atttypid = 'uuid'::regtype
      AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'outlet table % must have outlet_id UUID NOT NULL', target;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polrelid = target AND p.polname = 'tenant_isolation'
      AND NOT p.polpermissive AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'outlet table % must already enforce tenant RLS', target;
  END IF;
  -- Scalar subqueries become InitPlans: the scope is parsed once per
  -- statement, not once per row.
  EXECUTE format(
    'CREATE POLICY outlet_isolation ON %s AS RESTRICTIVE FOR ALL '
    'USING ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[])) '
    'WITH CHECK ((SELECT app.outlet_scope_is_tenant()) OR outlet_id = ANY ((SELECT app.scoped_outlet_ids())::uuid[]))',
    target);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_outlet_rls(regclass) FROM PUBLIC;
--> statement-breakpoint
-- Outlet-owned tables. public.payment_link_tokens is excluded on purpose: the
-- guest resolves it before any tenant or outlet context exists (TEN-02; see
-- the allowlist in src/db/rls.test.ts). Tables whose outlet_id is nullable hold
-- tenant- or brand-level rows (tax rules, journals, audit, events) and keep the
-- service-layer outlet filter only (contracts.md).
SELECT app.enforce_outlet_rls('public.item_availability'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.price_lists'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.core_storage_objects'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_locations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_batches'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_balances'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_transfers'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.stock_transfer_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.floor_zones'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.tables'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.table_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.session_participants'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_intents'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_evidence'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_unallocated_funds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_cashier_defaults'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_edc_terminals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_reconciliation_cases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.payment_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.tax_snapshots'::regclass);
