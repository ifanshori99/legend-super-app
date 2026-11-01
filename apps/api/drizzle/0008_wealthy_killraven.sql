CREATE TABLE "audit_logs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"outlet_id" uuid,
	"event" jsonb NOT NULL,
	"retention_class" varchar(32) DEFAULT 'audit_2y' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE INDEX "audit_logs_retention_idx" ON "audit_logs" USING btree ("tenant_id","created_at");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.audit_logs'::regclass);
--> statement-breakpoint
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_consistency CHECK ((
  retention_class = 'audit_2y' AND event->>'tenantId' = tenant_id::text
  AND event->>'outletId' IS NOT DISTINCT FROM outlet_id::text
  AND event->>'retentionClass' = retention_class
) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION app.guard_audit_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
     AND OLD.created_at <= CURRENT_TIMESTAMP - interval '2 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Audit records are append-only until retention expires';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION app.guard_audit_log();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.audit_logs FROM legend_app;
--> statement-breakpoint
-- Owner-only job hook; caller supplies a tenant and cannot shorten the PRD retention.
CREATE FUNCTION app.purge_expired_audit_logs(target_tenant uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE deleted bigint; previous_tenant text;
BEGIN
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.audit_logs'::regclass)) THEN
    RAISE EXCEPTION 'Audit retention requires table owner';
  END IF;
  previous_tenant := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', target_tenant::text, true);
  DELETE FROM public.audit_logs WHERE tenant_id = target_tenant AND retention_class = 'audit_2y'
    AND created_at <= CURRENT_TIMESTAMP - interval '2 years';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  RETURN deleted;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_expired_audit_logs(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.stamp_audit_creation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_creation_time BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION app.stamp_audit_creation();
