-- legend-usyi: audit retention purge runs as a dedicated NOLOGIN group that can
-- only EXECUTE two SECURITY DEFINER functions. It holds no table, sequence or
-- RLS-bypass right. Replaces the owner-only app.purge_expired_audit_logs hook.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_maintenance') THEN
    CREATE ROLE legend_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legend_maintenance' AND
                (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'legend_maintenance exists with unsafe privileges';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO legend_maintenance;
--> statement-breakpoint
DROP FUNCTION app.purge_expired_audit_logs(uuid);
--> statement-breakpoint
-- Crockford base32 of the 128-bit id, the same text as uuidToUlid in TypeScript.
CREATE FUNCTION app.audit_ulid_text(p_id uuid) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bits pg_catalog.bit(130);
  result text := '';
  position integer;
BEGIN
  bits := (B'00' || ('x' || pg_catalog.replace(p_id::text, '-', ''))::pg_catalog.bit(128))::pg_catalog.bit(130);
  FOR position IN 0..25 LOOP
    result := result || pg_catalog.substr(
      alphabet,
      (pg_catalog.substring(bits, position * 5 + 1, 5)::pg_catalog.bit(5))::integer + 1,
      1
    );
  END LOOP;
  RETURN result;
END $$;
--> statement-breakpoint
-- Time-ordered id: 48-bit millisecond clock plus 80 random bits.
CREATE FUNCTION app.new_audit_uuid() RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  random_hex text := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  millis bigint := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000)::bigint;
BEGIN
  -- Skip the fixed version and variant digits so all 80 bits are random.
  RETURN (
    pg_catalog.lpad(pg_catalog.to_hex(millis), 12, '0')
    || pg_catalog.substr(random_hex, 1, 12)
    || pg_catalog.substr(random_hex, 14, 3)
    || pg_catalog.substr(random_hex, 18, 5)
  )::uuid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_ulid_text(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.new_audit_uuid() FROM PUBLIC;
--> statement-breakpoint
-- Tenants with at least one expired row, archived ones included. Returns ids only.
CREATE FUNCTION app.audit_retention_due_tenants() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  due uuid;
BEGIN
  FOR due IN SELECT t.id FROM public.tenants t ORDER BY t.id LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', due::text, true);
    IF EXISTS (
      SELECT 1 FROM public.audit_logs a
      WHERE a.tenant_id = due AND a.retention_class = 'audit_2y'
        AND a.created_at <= CURRENT_TIMESTAMP - interval '2 years'
    ) THEN
      RETURN NEXT due;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  RETURN;
END $$;
--> statement-breakpoint
-- Deletes one batch of expired rows and, in the same transaction, writes ONE
-- summary row (a count and the cutoff only). An empty batch writes nothing.
CREATE FUNCTION app.purge_audit_retention_batch(p_tenant uuid, p_batch integer) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  previous_tenant text := pg_catalog.current_setting('app.tenant_id', true);
  cutoff timestamptz := CURRENT_TIMESTAMP - interval '2 years';
  deleted bigint;
  summary_id uuid;
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'Audit retention needs a tenant' USING ERRCODE = '22023';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 THEN
    RAISE EXCEPTION 'Audit retention batch must be between 1 and 5000' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', p_tenant::text, true);
  DELETE FROM public.audit_logs
  WHERE (tenant_id, id) IN (
    SELECT a.tenant_id, a.id FROM public.audit_logs a
    WHERE a.tenant_id = p_tenant AND a.retention_class = 'audit_2y'
      AND a.created_at <= cutoff
    ORDER BY a.created_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted > 0 THEN
    summary_id := app.new_audit_uuid();
    INSERT INTO public.audit_logs (tenant_id, id, outlet_id, event, retention_class)
    VALUES (
      p_tenant, summary_id, NULL,
      pg_catalog.jsonb_build_object(
        'id', app.audit_ulid_text(summary_id),
        'tenantId', p_tenant,
        'outletId', NULL::text,
        'actorType', 'system',
        'actorId', NULL::text,
        'deviceId', NULL::text,
        'action', 'audit.retention_purged',
        'objectType', 'audit_log',
        'objectId', NULL::text,
        'reason', NULL::text,
        'maskedChanges', pg_catalog.jsonb_build_object(
          'before', NULL::text,
          'after', pg_catalog.jsonb_build_object(
            'deletedCount', deleted,
            'cutoff', pg_catalog.to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'retentionClass', 'audit_2y'
          )
        ),
        'ipHash', NULL::text,
        'sensitiveAccess', false,
        'retentionClass', 'audit_2y',
        'createdAt', pg_catalog.to_char(pg_catalog.statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'audit_2y'
    );
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  RETURN deleted;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_retention_due_tenants() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_audit_retention_batch(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_retention_due_tenants() TO legend_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_audit_retention_batch(uuid, integer) TO legend_maintenance;
