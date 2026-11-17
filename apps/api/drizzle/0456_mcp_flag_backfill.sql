-- Custom SQL migration file, put your code below! ---
-- legend-hbuq3 / 981 follow-up item 4: `mcp` is now a real module switch
-- (feature_flags.modules, fail-closed). Tenants that already use MCP would be
-- locked out at release, so switch the module on for a tenant that
--   (1) is active (tenants.status = 'active'),
--   (2) is on a package whose modules contain 'mcp' (platform_packages.key =
--       tenants.plan; setTenantPackage refuses MODULE_NOT_IN_PACKAGE, and a module
--       the package does not pay for must not be switched on, so a tenant whose
--       package lacks mcp is NOT given the flag even if it used MCP), AND
--   (3) has an approved MCP client (mcp_clients.status = 'approved'; 'pending' and
--       'revoked' do not count: a client nobody approved has not used MCP),
--       OR an active MCP token (revoked_at IS NULL AND expires_at > now()).
-- Every other tenant is not touched. Only feature_flags.modules is appended
-- with "mcp"; other modules, integrationProviders, limits, plan and status stay
-- as they are. Real shape: {"modules": [...], "integrationProviders": [...]},
-- strict schema, so there is no stored "false": off means absent from modules.
--
-- Idempotent: a tenant that already has "mcp" is skipped, so a re-run changes
-- nothing and writes no audit row. Data only, no DDL.
--
-- One audit_logs row per changed tenant (actor system, no actor id), written in
-- the loop right after the update, with the tenant context already set (audit_logs
-- is FORCE RLS). The time-ordered audit id and its ULID text are built inline
-- (same formulas as app.new_audit_uuid / app.audit_ulid_text in 0187), because
-- those two helpers are revoked from PUBLIC and a migration must not depend on
-- that grant, as in 0378.
--
-- mcp_clients and mcp_tokens have FORCE ROW LEVEL SECURITY with
-- app.require_tenant_id() (0114), which raises 42501 without a tenant context.
-- So, as in 0221, the block sets app.tenant_id per tenant (transaction-local)
-- and restores the previous value at the end. When a tenant context is already
-- set (a scoped replay as the runtime role), only that tenant is processed, so
-- no other tenant is read or written.
DO $$
DECLARE
  previous text := coalesce(current_setting('app.tenant_id', true), '');
  r record;
  modules_after jsonb;
  raw text;
  audit_id uuid;
  audit_bits bit(130);
  audit_ulid text;
BEGIN
  FOR r IN
    SELECT t.id, t.feature_flags -> 'modules' AS modules_before
    FROM public.tenants t
    JOIN public.platform_packages p ON p.key = t.plan
    WHERE t.status = 'active'
      AND p.modules ? 'mcp'
      AND jsonb_typeof(t.feature_flags -> 'modules') = 'array'
      AND NOT (t.feature_flags -> 'modules') ? 'mcp'
      AND (previous = '' OR t.id::text = previous)
  LOOP
    PERFORM set_config('app.tenant_id', r.id::text, true);
    IF EXISTS (
      SELECT 1 FROM public.mcp_clients c
      WHERE c.tenant_id = r.id AND c.status = 'approved'
    ) OR EXISTS (
      SELECT 1 FROM public.mcp_tokens k
      WHERE k.tenant_id = r.id AND k.revoked_at IS NULL AND k.expires_at > now()
    ) THEN
      UPDATE public.tenants
      SET feature_flags = jsonb_set(
        feature_flags,
        '{modules}',
        (feature_flags -> 'modules') || '"mcp"'::jsonb
      )
      WHERE id = r.id
        AND NOT (feature_flags -> 'modules') ? 'mcp'
      RETURNING feature_flags -> 'modules' INTO modules_after;
      IF FOUND THEN
        raw := replace(gen_random_uuid()::text, '-', '');
        audit_id := (
          lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
          || substr(raw, 1, 12) || substr(raw, 14, 3) || substr(raw, 18, 5)
        )::uuid;
        audit_bits := (B'00' || ('x' || replace(audit_id::text, '-', ''))::bit(128))::bit(130);
        SELECT string_agg(
          substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (substring(audit_bits, pos * 5 + 1, 5)::bit(5))::integer + 1, 1),
          '' ORDER BY pos
        ) INTO audit_ulid
        FROM generate_series(0, 25) AS pos;
        INSERT INTO public.audit_logs (tenant_id, id, outlet_id, event, retention_class)
        VALUES (
          r.id, audit_id, NULL,
          jsonb_build_object(
            'id', audit_ulid,
            'tenantId', r.id,
            'outletId', NULL,
            'actorType', 'system',
            'actorId', NULL,
            'deviceId', NULL,
            'action', 'tenant.module_auto_enabled',
            'objectType', 'tenant',
            'objectId', r.id,
            'reason', 'Migrasi 0456: modul mcp dinyalakan otomatis untuk tenant dengan paket yang memuat mcp dan klien atau token MCP aktif',
            'maskedChanges', jsonb_build_object(
              'before', jsonb_build_object('modules', r.modules_before),
              'after', jsonb_build_object('modules', modules_after)
            ),
            'ipHash', NULL,
            'sensitiveAccess', false,
            'retentionClass', 'audit_2y',
            'createdAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ),
          'audit_2y'
        );
      END IF;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', previous, true);
END $$;
