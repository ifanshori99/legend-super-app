CREATE TABLE "entitlement_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"type" varchar(10) NOT NULL,
	"sessions" integer NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_ref" varchar(40) NOT NULL,
	"rule_id" uuid,
	"grant_entry_id" uuid,
	"access_ticket_id" uuid,
	"expires_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"reason" varchar(500),
	"posting_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "entitlement_ledger_posting_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_ledger_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "entitlement_ledger_type_check" CHECK ("entitlement_ledger"."type" IN ('grant', 'redeem', 'cancel', 'expire')),
	CONSTRAINT "entitlement_ledger_source_check" CHECK ("entitlement_ledger"."source_type" IN ('purchase', 'package', 'min_spend', 'tier_benefit', 'subscription', 'staff_issue')),
	CONSTRAINT "entitlement_ledger_sessions_check" CHECK ("entitlement_ledger"."sessions" BETWEEN 1 AND 100),
	CONSTRAINT "entitlement_ledger_shape_check" CHECK (("entitlement_ledger"."type" = 'grant' AND "entitlement_ledger"."grant_entry_id" IS NULL AND "entitlement_ledger"."access_ticket_id" IS NULL)
        OR ("entitlement_ledger"."type" = 'redeem' AND "entitlement_ledger"."grant_entry_id" IS NOT NULL AND "entitlement_ledger"."access_ticket_id" IS NOT NULL AND "entitlement_ledger"."sessions" = 1 AND "entitlement_ledger"."expires_at" IS NULL)
        OR ("entitlement_ledger"."type" IN ('cancel', 'expire') AND "entitlement_ledger"."grant_entry_id" IS NOT NULL AND "entitlement_ledger"."access_ticket_id" IS NULL AND "entitlement_ledger"."expires_at" IS NULL)),
	CONSTRAINT "entitlement_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "entitlement_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "entitlement_ledger_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "entitlement_ledger_grant_fk" FOREIGN KEY ("tenant_id","grant_entry_id") REFERENCES "public"."entitlement_ledger"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_ledger_grant_dedupe" ON "entitlement_ledger" USING btree ("tenant_id","facility_id","customer_profile_id","source_type","source_ref",COALESCE("rule_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "entitlement_ledger"."type" = 'grant';--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_ledger_terminal_key" ON "entitlement_ledger" USING btree ("tenant_id","grant_entry_id") WHERE "entitlement_ledger"."type" IN ('cancel', 'expire');--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_ledger_ticket_key" ON "entitlement_ledger" USING btree ("tenant_id","access_ticket_id") WHERE "entitlement_ledger"."access_ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entitlement_ledger_customer_idx" ON "entitlement_ledger" USING btree ("tenant_id","customer_profile_id","facility_id","posting_seq");--> statement-breakpoint
CREATE INDEX "entitlement_ledger_grant_entry_idx" ON "entitlement_ledger" USING btree ("tenant_id","grant_entry_id") WHERE "entitlement_ledger"."grant_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entitlement_ledger_source_idx" ON "entitlement_ledger" USING btree ("tenant_id","source_type","source_ref");--> statement-breakpoint
CREATE INDEX "entitlement_ledger_outlet_idx" ON "entitlement_ledger" USING btree ("tenant_id","outlet_id","occurred_at");
--> statement-breakpoint
-- Hand SQL for entitlement_ledger (bead legend-fjk5; PRD v1.7 §3 F25 "Produk &
-- Hak Akses", §6 K; FAC-04, FAC-05). Appended to
-- drizzle/0213_facility_entitlement_ledger.sql. Foreign keys are inline in the
-- generated DDL (the migrator is not a superuser).

-- TEN-01, TEN-03: tenant-owned and outlet-owned (outlet_id NOT NULL).
SELECT app.enforce_tenant_rls('public.entitlement_ledger'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.entitlement_ledger'::regclass);
--> statement-breakpoint
-- FAC-05: the ledger is append-only. A trigger (not only a privilege) also
-- blocks the owner and the migrator (pattern 0203 point_ledger). A grant is
-- ended by a `cancel` or `expire` row, never by an edit.
CREATE FUNCTION app.reject_entitlement_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'entitlement_ledger is append-only (FAC-05)' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_append_only
BEFORE UPDATE OR DELETE ON public.entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION app.reject_entitlement_ledger_mutation();
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_no_truncate
BEFORE TRUNCATE ON public.entitlement_ledger
FOR EACH STATEMENT EXECUTE FUNCTION app.reject_entitlement_ledger_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_entitlement_ledger_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.entitlement_ledger FROM legend_app;
--> statement-breakpoint
-- FAC-05: second line of defence against double redemption. A redeem, cancel
-- or expire row locks its grant (one transaction at a time per grant), checks
-- that the grant exists for the same customer and facility, and refuses the
-- row when it would draw down more sessions than the grant has left. The
-- service takes a wider lock first; this holds even for a caller that does not.
CREATE FUNCTION app.entitlement_ledger_guard_draw_down() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_sessions integer;
  v_customer uuid;
  v_facility uuid;
  v_used bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.grant_entry_id::text));
  SELECT g.sessions, g.customer_profile_id, g.facility_id
    INTO v_sessions, v_customer, v_facility
    FROM public.entitlement_ledger g
   WHERE g.tenant_id = NEW.tenant_id
     AND g.id = NEW.grant_entry_id
     AND g.type = 'grant';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entitlement grant not found' USING ERRCODE = '23503';
  END IF;
  IF v_customer <> NEW.customer_profile_id OR v_facility <> NEW.facility_id THEN
    RAISE EXCEPTION 'entitlement row does not match its grant (customer or facility)'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(d.sessions), 0) INTO v_used
    FROM public.entitlement_ledger d
   WHERE d.tenant_id = NEW.tenant_id
     AND d.grant_entry_id = NEW.grant_entry_id;
  IF v_sessions - v_used < NEW.sessions THEN
    RAISE EXCEPTION 'entitlement overdraw: % left, % requested', v_sessions - v_used, NEW.sessions
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER entitlement_ledger_draw_down_guard
BEFORE INSERT ON public.entitlement_ledger
FOR EACH ROW WHEN (NEW.type <> 'grant')
EXECUTE FUNCTION app.entitlement_ledger_guard_draw_down();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.entitlement_ledger_guard_draw_down() FROM PUBLIC;
