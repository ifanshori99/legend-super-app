-- legend-i5kc: a backdated disposal/revaluation takes back the depreciation of
-- the months after the event. fixed_asset_depreciations stays append-only for
-- legend_app (0058: no UPDATE/DELETE): a row is "taken back" by a row in
-- fixed_asset_depreciation_reversals (also append-only) that points at the
-- correcting journal, and the month may then be depreciated again as a new
-- generation of the same (asset, period). A month can only get a new
-- generation once every earlier generation has its reversal, so the ledger can
-- never hold two active rows for one asset and month.
ALTER TABLE "fixed_asset_depreciations" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_generation_check" CHECK ("fixed_asset_depreciations"."generation" >= 1);
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" DROP CONSTRAINT "fixed_asset_depreciations_asset_period_key";
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_asset_period_generation_key" UNIQUE("tenant_id","fixed_asset_id","period","generation");
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_tenant_id_key" UNIQUE("tenant_id","id");
--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciation_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"depreciation_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reason" varchar(200) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_depreciation_reversals_depreciation_key" UNIQUE("tenant_id","depreciation_id"),
	CONSTRAINT "fixed_asset_depreciation_reversals_reason_check" CHECK (length(btrim("fixed_asset_depreciation_reversals"."reason")) > 0),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1).
	CONSTRAINT "fixed_asset_depreciation_reversals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "fixed_asset_depreciation_reversals_depreciation_fk" FOREIGN KEY ("tenant_id","depreciation_id") REFERENCES "public"."fixed_asset_depreciations"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "fixed_asset_depreciation_reversals_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "fixed_asset_depreciation_reversals_journal_idx" ON "fixed_asset_depreciation_reversals" USING btree ("tenant_id","journal_entry_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.fixed_asset_depreciation_reversals'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.fixed_asset_depreciation_reversals FROM legend_app;
--> statement-breakpoint
CREATE FUNCTION app.assert_depreciation_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- A new generation must be the newest one of the asset+month, and every
  -- earlier generation must already be taken back by a reversal row.
  IF EXISTS (
    SELECT 1 FROM public.fixed_asset_depreciations d
    WHERE d.tenant_id = NEW.tenant_id
      AND d.fixed_asset_id = NEW.fixed_asset_id
      AND d.period = NEW.period
      AND (
        d.generation >= NEW.generation
        OR NOT EXISTS (
          SELECT 1 FROM public.fixed_asset_depreciation_reversals r
          WHERE r.tenant_id = d.tenant_id AND r.depreciation_id = d.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'asset % already has active depreciation for % (DEPRECIATION_ALREADY_POSTED)', NEW.fixed_asset_id, NEW.period
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fixed_asset_depreciations_generation
BEFORE INSERT ON public.fixed_asset_depreciations
FOR EACH ROW EXECUTE FUNCTION app.assert_depreciation_generation();
