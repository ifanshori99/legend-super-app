-- Custom SQL migration file, put your code below! ---
-- legend-0m495 / 864: Tanya AI is locked by default (ai-platform-lock.ts is
-- fail-closed: a tenant without 'ai_assistant' in feature_flags.modules gets
-- AI_PLATFORM_DISABLED), so tenants that already used AI before the lock would
-- be locked out at release. Founder Q6 (15 Nov 2026), option A: switch the
-- module on automatically ONLY for a tenant that
--   (1) is active,
--   (2) is on an ACTIVE package whose modules contain 'ai_assistant'
--       (platform_packages.key = tenants.plan; a retired package or a package
--       without AI never gets the module, so nobody gets AI that the package
--       does not pay for: cost rule), AND
--   (3) has really used AI: an ai_usage_events row with status 'ok' on channel
--       tanya_ai or mcp (not 'job', which the system runs by itself; not
--       'error' / 'blocked'), or a user message in ai_messages. Configuration
--       alone (ai_settings, ai_provider_configs, ai_chatgpt_connections) is
--       NOT use.
-- Every other tenant stays locked and is enabled per tenant by a Super Admin
-- (setTenantPackage, unchanged).
--
-- Idempotent: a tenant that already has the module is skipped, so a re-run
-- changes nothing and writes no audit row. Only feature_flags.modules is
-- touched (appended); plan, limits and integrationProviders stay as they are.
-- One audit_logs row per changed tenant (actor system, no actor id), written
-- in the same statement as the update so the two cannot diverge. The time-ordered
-- audit id and its ULID text are built inline (same formulas as
-- app.new_audit_uuid / app.audit_ulid_text in 0187), because those two helpers
-- are revoked from PUBLIC and a migration must not depend on that grant.
--
-- Runs as the migration owner, so it spans every tenant. tenants and
-- platform_packages have no FORCE RLS. audit_logs, ai_usage_events and
-- ai_messages do: the migrator may be a plain table owner (no BYPASSRLS), and
-- FORCE would then raise 42501 (no app.tenant_id). Lift FORCE for this
-- transaction only and restore it before commit, as in 0116, 0147, 0205, 0335
-- and 0360.
ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_usage_events NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_messages NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH eligible AS (
  SELECT t.id, t.feature_flags
  FROM public.tenants t
  JOIN public.platform_packages p ON p.key = t.plan
  WHERE t.status = 'active'
    AND p.status = 'active'
    AND p.modules ? 'ai_assistant'
    AND jsonb_typeof(t.feature_flags -> 'modules') = 'array'
    AND NOT (t.feature_flags -> 'modules') ? 'ai_assistant'
    AND (
      EXISTS (
        SELECT 1 FROM public.ai_usage_events e
        WHERE e.tenant_id = t.id
          AND e.status = 'ok'
          AND e.channel IN ('tanya_ai', 'mcp')
      )
      OR EXISTS (
        SELECT 1 FROM public.ai_messages m
        WHERE m.tenant_id = t.id AND m.role = 'user'
      )
    )
  FOR UPDATE OF t
),
updated AS (
  UPDATE public.tenants t
  SET feature_flags = jsonb_set(
    t.feature_flags,
    '{modules}',
    (t.feature_flags -> 'modules') || '"ai_assistant"'::jsonb
  )
  FROM eligible
  WHERE t.id = eligible.id
  RETURNING t.id, eligible.feature_flags -> 'modules' AS modules_before,
    t.feature_flags -> 'modules' AS modules_after
)
INSERT INTO public.audit_logs (tenant_id, id, outlet_id, event, retention_class)
SELECT u.id, a.id, NULL,
  jsonb_build_object(
    'id', a.ulid,
    'tenantId', u.id,
    'outletId', NULL,
    'actorType', 'system',
    'actorId', NULL,
    'deviceId', NULL,
    'action', 'tenant.module_auto_enabled',
    'objectType', 'tenant',
    'objectId', u.id,
    'reason', 'Keputusan founder Q6 (15 Nov 2026): modul ai_assistant dinyalakan otomatis untuk tenant dengan paket AI yang sudah memakai AI',
    'maskedChanges', jsonb_build_object(
      'before', jsonb_build_object('modules', u.modules_before),
      'after', jsonb_build_object('modules', u.modules_after)
    ),
    'ipHash', NULL,
    'sensitiveAccess', false,
    'retentionClass', 'audit_2y',
    'createdAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  'audit_2y'
FROM updated u
CROSS JOIN LATERAL (
  SELECT n.id,
    (
      SELECT string_agg(
        substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (substring(n.bits, pos * 5 + 1, 5)::bit(5))::integer + 1, 1),
        '' ORDER BY pos
      )
      FROM generate_series(0, 25) AS pos
    ) AS ulid
  FROM (
    SELECT k.id, (B'00' || ('x' || replace(k.id::text, '-', ''))::bit(128))::bit(130) AS bits
    FROM (
      SELECT (
        lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
        || substr(r.hex, 1, 12) || substr(r.hex, 14, 3) || substr(r.hex, 18, 5)
      )::uuid AS id
      FROM (SELECT replace(gen_random_uuid()::text, '-', '') AS hex WHERE u.id IS NOT NULL) r
    ) k
  ) n
) a;
--> statement-breakpoint
ALTER TABLE public.ai_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_usage_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
