-- Payroll disbursement (bead legend-wnkep.1, founder Q15-Q17): how each legal
-- entity pays net pay. Method `duitku` is stored but not usable yet (adapter
-- is legend-wnkep.3); `doit` is not allowed at all (founder deferred it).
-- Foreign keys are inline while the table is empty (docs/plan/contracts.md,
-- pattern 1: a later ADD CONSTRAINT would scan FORCE-RLS parents without a
-- tenant context).
CREATE TABLE "payroll_payout_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"method" varchar(12) NOT NULL,
	"integration_id" uuid,
	"manual_source_bank_account_id" uuid NOT NULL,
	"manual_bank_format" varchar(12) DEFAULT 'generic_csv' NOT NULL,
	"max_per_transfer_idr" bigint DEFAULT 50000000 NOT NULL,
	"daily_cap_idr" bigint,
	"fee_per_transfer_idr" bigint DEFAULT 5000 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_payout_configs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_payout_configs_tenant_entity_key" UNIQUE("tenant_id","legal_entity_id"),
	CONSTRAINT "payroll_payout_configs_method_check" CHECK ("payroll_payout_configs"."method" IN ('duitku', 'manual_bank')),
	CONSTRAINT "payroll_payout_configs_integration_check" CHECK (("payroll_payout_configs"."method" = 'duitku') = ("payroll_payout_configs"."integration_id" IS NOT NULL)),
	CONSTRAINT "payroll_payout_configs_bank_format_check" CHECK ("payroll_payout_configs"."manual_bank_format" IN ('generic_csv', 'bca', 'mandiri', 'bni', 'bjb')),
	CONSTRAINT "payroll_payout_configs_max_per_transfer_check" CHECK ("payroll_payout_configs"."max_per_transfer_idr" > 0 AND "payroll_payout_configs"."max_per_transfer_idr" <= 100000000),
	CONSTRAINT "payroll_payout_configs_daily_cap_check" CHECK ("payroll_payout_configs"."daily_cap_idr" IS NULL OR "payroll_payout_configs"."daily_cap_idr" > 0),
	CONSTRAINT "payroll_payout_configs_fee_check" CHECK ("payroll_payout_configs"."fee_per_transfer_idr" >= 0),
	CONSTRAINT "payroll_payout_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_configs_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_configs_integration_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."tenant_integrations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "payroll_payout_configs_source_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","manual_source_bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.payroll_payout_configs'::regclass);
--> statement-breakpoint
-- A payout configuration is never deleted (history of who could pay how).
REVOKE DELETE, TRUNCATE ON TABLE public.payroll_payout_configs FROM legend_app;
--> statement-breakpoint
-- The Duitku integration of a config must be a Duitku integration of the same
-- tenant. tenant_integrations has no (tenant_id, id) key, so the composite
-- foreign key is a trigger. It reads under the caller's RLS context, so a row
-- of another tenant is invisible and rejected the same way. Whether the
-- integration is active is checked by the service when the config is saved.
CREATE OR REPLACE FUNCTION app.payroll_payout_configs_integration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.integration_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_integrations t
      WHERE t.id = NEW.integration_id
        AND t.tenant_id = NEW.tenant_id
        AND t.provider = 'duitku'
  ) THEN
    RAISE EXCEPTION 'PAYOUT-31: payout config integration % is not a Duitku integration of this tenant', NEW.integration_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payroll_payout_configs_integration_guard_trg ON public.payroll_payout_configs;
--> statement-breakpoint
CREATE TRIGGER payroll_payout_configs_integration_guard_trg
  BEFORE INSERT OR UPDATE OF tenant_id, integration_id ON public.payroll_payout_configs
  FOR EACH ROW EXECUTE FUNCTION app.payroll_payout_configs_integration_guard();
