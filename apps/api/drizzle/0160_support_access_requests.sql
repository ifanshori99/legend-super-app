-- legend-c9kbk (founder Q37/Q38): support_access_requests, and the grant side of
-- the owner-approval link. Composite (tenant_id, id) keys let each table point
-- at the other inside one tenant only.
ALTER TABLE "support_access_grants" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
CREATE TABLE "support_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"super_admin_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"access_mode" varchar(20) DEFAULT 'read_write' NOT NULL,
	"duration_minutes" integer NOT NULL,
	"mfa_verified_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approval_expires_at" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"grant_id" uuid,
	"owner_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_request_mode_check" CHECK ("support_access_requests"."access_mode" = 'read_write'),
	CONSTRAINT "support_access_request_duration_check" CHECK ("support_access_requests"."duration_minutes" IN (15, 30)),
	CONSTRAINT "support_access_request_window_check" CHECK ("support_access_requests"."approval_expires_at" = "support_access_requests"."requested_at" + interval '24 hours'),
	CONSTRAINT "support_access_request_mfa_check" CHECK ("support_access_requests"."mfa_verified_at" <= "support_access_requests"."requested_at"),
	CONSTRAINT "support_access_request_status_check" CHECK ("support_access_requests"."status" IN ('pending', 'approved', 'rejected', 'expired')),
	CONSTRAINT "support_access_request_decided_at_check" CHECK (("support_access_requests"."status" = 'pending') = ("support_access_requests"."decided_at" IS NULL)),
	CONSTRAINT "support_access_request_decided_by_check" CHECK (("support_access_requests"."status" IN ('approved', 'rejected')) = ("support_access_requests"."decided_by" IS NOT NULL)),
	CONSTRAINT "support_access_request_no_self_decision_check" CHECK ("support_access_requests"."decided_by" IS NULL OR "support_access_requests"."decided_by" <> "support_access_requests"."super_admin_user_id"),
	CONSTRAINT "support_access_request_grant_check" CHECK (("support_access_requests"."status" = 'approved') = ("support_access_requests"."grant_id" IS NOT NULL)),
	CONSTRAINT "support_access_request_approved_in_time_check" CHECK ("support_access_requests"."status" <> 'approved' OR "support_access_requests"."decided_at" < "support_access_requests"."approval_expires_at"),
	CONSTRAINT "support_access_request_expired_late_check" CHECK ("support_access_requests"."status" <> 'expired' OR "support_access_requests"."decided_at" >= "support_access_requests"."approval_expires_at"),
	CONSTRAINT "support_access_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	-- Foreign keys inline (docs/plan/contracts.md "foreign keys into FORCE RLS
	-- tables", pattern 1): support_access_grants is FORCE RLS, so an ALTER TABLE
	-- ... ADD FOREIGN KEY would run a validation scan without app.tenant_id.
	-- grant_id has no foreign key on purpose: the binding foreign key runs the
	-- other way (support_access_grants.approval_request_id, below), and a second
	-- one back would make every grant undeletable while its request exists.
	CONSTRAINT "support_access_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "support_access_request_tenant_requested_idx" ON "support_access_requests" USING btree ("tenant_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_request_one_pending_key" ON "support_access_requests" USING btree ("tenant_id","super_admin_user_id") WHERE "support_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "support_access_request_due_idx" ON "support_access_requests" USING btree ("tenant_id","status","approval_expires_at");--> statement-breakpoint
-- Grant side (docs/plan/contracts.md, pattern 2): the foreign key is added by
-- ALTER on the existing FORCE table support_access_grants, so FORCE is lifted
-- for the scan and restored right after. support_access_requests has no RLS yet
-- at this point (it is enforced below), so it needs no lift.
ALTER TABLE public.support_access_grants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_approval_request_fk" FOREIGN KEY ("tenant_id","approval_request_id") REFERENCES "public"."support_access_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.support_access_grants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_grants_approval_request_key" ON "support_access_grants" USING btree ("approval_request_id") WHERE "support_access_grants"."approval_request_id" IS NOT NULL;--> statement-breakpoint
-- NOT VALID by hand: read_write grants opened before the approval flow have no
-- request. Postgres still checks every INSERT and UPDATE, so closed rows
-- (ended_at or expiry_recorded_at set) are exempt: a legacy open write grant can
-- still be ended or recorded as expired, while an unapproved open write grant
-- can never be inserted.
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grant_write_approved_check" CHECK ("support_access_grants"."access_mode" = 'read_only' OR "support_access_grants"."approval_request_id" IS NOT NULL OR "support_access_grants"."ended_at" IS NOT NULL OR "support_access_grants"."expiry_recorded_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
-- legend-c9kbk (founder Q37/Q38, TEN-04): requests for a read_write support
-- session that a tenant owner must approve. Tenant-owned, so forced tenant RLS
-- (TEN-01/02). A decided row (approved, rejected, expired) is final; a pending
-- row may only be decided (status/decided_at/decided_by/grant_id) or have
-- owner_notified_at set once. Everything the request promised stays fixed.
SELECT app.enforce_tenant_rls('public.support_access_requests'::regclass);
--> statement-breakpoint
-- A request is never deleted (audit trail); the guard trigger covers UPDATE.
REVOKE DELETE, TRUNCATE ON TABLE public.support_access_requests FROM legend_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.support_access_requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'TEN-04: support access request % is already decided', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.super_admin_user_id <> OLD.super_admin_user_id
    OR NEW.reason <> OLD.reason
    OR NEW.access_mode <> OLD.access_mode
    OR NEW.duration_minutes <> OLD.duration_minutes
    OR NEW.mfa_verified_at <> OLD.mfa_verified_at
    OR NEW.requested_at <> OLD.requested_at
    OR NEW.approval_expires_at <> OLD.approval_expires_at
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'TEN-04: support access request % cannot change what was requested', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.owner_notified_at IS NOT NULL
    AND NEW.owner_notified_at IS DISTINCT FROM OLD.owner_notified_at
  THEN
    RAISE EXCEPTION 'TEN-04: support access request % owner notification is final', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "support_access_requests_guard_trg"
  BEFORE UPDATE ON "support_access_requests"
  FOR EACH ROW EXECUTE FUNCTION app.support_access_requests_guard();

--> statement-breakpoint
-- legend-c9kbk (Q37): new permission `org.support_access.approve` (answer a
-- support read_write request), owner template only (packages/shared/src/access
-- roles.ts takes every non-platform, non-self code). Template roles already
-- copied into existing tenants keep their old list (seedTenantRoleTemplates
-- inserts once), so add the code to their owner rows here. Additive and
-- idempotent. `roles` has FORCE RLS, so each tenant is named (precedent:
-- 0104_edc_standalone_permission.sql).
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions || '["org.support_access.approve"]'::jsonb,
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key = 'owner'
      AND NOT (permissions ? 'org.support_access.approve');
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
