-- A non-superuser table owner (0068) validates the foreign keys and runs the
-- backfill below under forced RLS without a tenant: lift it on the parents for
-- this migration only (contracts.md pattern 2), restored at the end.
ALTER TABLE public.shareholders NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.distribution_lines NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shareholder_recipient_versions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"shareholder_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_user_id" text,
	"user_id" text,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"approval_chain_id" uuid,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"idempotency_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shareholder_recipient_versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "shareholder_recipient_versions_version_key" UNIQUE("tenant_id","shareholder_id","version"),
	CONSTRAINT "shareholder_recipient_versions_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "shareholder_recipient_versions_version_check" CHECK ("shareholder_recipient_versions"."version" >= 1),
	CONSTRAINT "shareholder_recipient_versions_status_check" CHECK ("shareholder_recipient_versions"."status" IN ('pending_approval', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "shareholder_recipient_versions_change_check" CHECK ("shareholder_recipient_versions"."user_id" IS DISTINCT FROM "shareholder_recipient_versions"."previous_user_id"),
	CONSTRAINT "shareholder_recipient_versions_decided_check" CHECK (("shareholder_recipient_versions"."status" IN ('approved', 'rejected')) = ("shareholder_recipient_versions"."decided_by" IS NOT NULL AND "shareholder_recipient_versions"."decided_at" IS NOT NULL)),
	CONSTRAINT "shareholder_recipient_versions_four_eyes_check" CHECK ("shareholder_recipient_versions"."decided_by" IS NULL OR "shareholder_recipient_versions"."decided_by" <> "shareholder_recipient_versions"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "distribution_lines" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "shareholder_recipient_versions" ADD CONSTRAINT "shareholder_recipient_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shareholder_recipient_versions" ADD CONSTRAINT "shareholder_recipient_versions_shareholder_fk" FOREIGN KEY ("tenant_id","shareholder_id") REFERENCES "public"."shareholders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shareholder_recipient_versions_pending_key" ON "shareholder_recipient_versions" USING btree ("tenant_id","shareholder_id") WHERE "shareholder_recipient_versions"."status" = 'pending_approval';--> statement-breakpoint
CREATE INDEX "shareholder_recipient_versions_chain_idx" ON "shareholder_recipient_versions" USING btree ("tenant_id","approval_chain_id");--> statement-breakpoint
CREATE INDEX "distribution_lines_recipient_idx" ON "distribution_lines" USING btree ("tenant_id","recipient_user_id");--> statement-breakpoint
-- Custom SQL (Codex 379, bead legend-33im6): recipient changes are versioned
-- and approved; past lines keep the recipient they were created for.
--
-- 1. Tenant RLS on the new table (TEN-01/02); nothing is ever deleted.
-- 2. Backfill: a line created before this migration takes its shareholder's
--    login as it is now (the only identity known). The lines guard freezes
--    lines of submitted runs, so it is paused for this one statement only.
-- 3. A decided recipient version is frozen; only pending_approval may move.
SELECT app.enforce_tenant_rls('public.shareholder_recipient_versions'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.shareholder_recipient_versions FROM legend_app;
--> statement-breakpoint
ALTER TABLE public.distribution_lines DISABLE TRIGGER distribution_lines_guard_trg;
--> statement-breakpoint
UPDATE public.distribution_lines l
SET recipient_user_id = s.user_id
FROM public.shareholders s
WHERE s.tenant_id = l.tenant_id AND s.id = l.shareholder_id
  AND l.recipient_user_id IS NULL AND s.user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.distribution_lines ENABLE TRIGGER distribution_lines_guard_trg;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.shareholder_recipient_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  decision_cols text[] := ARRAY['status', 'decided_by', 'decided_at',
    'decision_note', 'approval_chain_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shareholder recipient version % cannot be deleted', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_approval' AND NEW.approval_chain_id IS NOT NULL THEN
      RAISE EXCEPTION 'a recipient version with an approval chain starts pending'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'shareholder recipient version % is frozen (status %)', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - decision_cols) <> (to_jsonb(OLD) - decision_cols) THEN
    RAISE EXCEPTION 'shareholder recipient version % identity cannot change', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "shareholder_recipient_versions_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "shareholder_recipient_versions"
  FOR EACH ROW EXECUTE FUNCTION app.shareholder_recipient_versions_guard();
--> statement-breakpoint
-- 4. Paying a line also records who it was paid to: a login linked after the
--    line was created must still see its statement, so recipient_user_id joins
--    the pay-once columns (draft lines stay free, nothing else is loosened).
CREATE OR REPLACE FUNCTION app.distribution_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  run_status text;
  payment_cols text[] := ARRAY['payment_status', 'payment_ref', 'paid_at', 'paid_by',
    'recipient_user_id'];
BEGIN
  SELECT r.status INTO run_status FROM public.distribution_runs r
  WHERE r.tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id)
    AND r.id = coalesce(NEW.distribution_run_id, OLD.distribution_run_id)
  FOR SHARE;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.id, NEW.distribution_run_id)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.distribution_run_id) THEN
    RAISE EXCEPTION 'SH-04: distribution line identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF run_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Pay once, on an approved run, nothing else changing.
    IF run_status = 'approved' AND OLD.payment_status = 'pending'
       AND NEW.payment_status = 'paid'
       AND (to_jsonb(NEW) - payment_cols) = (to_jsonb(OLD) - payment_cols) THEN
      RETURN NEW;
    END IF;
    -- Attach a paid line's statement once.
    IF run_status IN ('approved', 'paid') AND OLD.payment_status = 'paid'
       AND OLD.statement_file_key IS NULL AND NEW.statement_file_key IS NOT NULL
       AND (to_jsonb(NEW) - 'statement_file_key') = (to_jsonb(OLD) - 'statement_file_key') THEN
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SH-04: lines of distribution run % are frozen (status %)',
    coalesce(NEW.distribution_run_id, OLD.distribution_run_id), run_status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
ALTER TABLE public.distribution_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shareholders FORCE ROW LEVEL SECURITY;
