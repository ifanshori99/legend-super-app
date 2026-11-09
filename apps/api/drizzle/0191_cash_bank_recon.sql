-- WS-07 cash & bank (bead legend-fnxl). Tables are created in dependency
-- order so every foreign key can sit inside its CREATE TABLE.
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"bank" varchar(50) NOT NULL,
	"account_name" varchar(150) NOT NULL,
	"account_number_encrypted" "bytea" NOT NULL,
	"account_number_hmac" varchar(64) NOT NULL,
	"account_number_last4" char(4) NOT NULL,
	"account_number_key_version" integer NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"csv_mapping" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_accounts_tenant_entity_id_key" UNIQUE("tenant_id","legal_entity_id","id"),
	CONSTRAINT "bank_accounts_number_key" UNIQUE("tenant_id","legal_entity_id","account_number_hmac"),
	CONSTRAINT "bank_accounts_last4_check" CHECK ("bank_accounts"."account_number_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "bank_accounts_hmac_check" CHECK ("bank_accounts"."account_number_hmac" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_accounts_key_version_check" CHECK ("bank_accounts"."account_number_key_version" >= 1),
	CONSTRAINT "bank_accounts_text_check" CHECK (char_length(btrim("bank_accounts"."bank")) >= 2 AND char_length(btrim("bank_accounts"."account_name")) >= 1),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_accounts_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_accounts_gl_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","gl_account_id") REFERENCES "public"."chart_of_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_name" varchar(150) NOT NULL,
	"file_sha256" varchar(64) NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"line_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"auto_matched_count" integer NOT NULL,
	"posted_from" date,
	"posted_to" date,
	CONSTRAINT "bank_statement_imports_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_statement_imports_account_id_key" UNIQUE("tenant_id","bank_account_id","id"),
	CONSTRAINT "bank_statement_imports_counts_check" CHECK ("bank_statement_imports"."line_count" >= 0 AND "bank_statement_imports"."duplicate_count" >= 0 AND "bank_statement_imports"."auto_matched_count" >= 0 AND "bank_statement_imports"."auto_matched_count" <= "bank_statement_imports"."line_count"),
	CONSTRAINT "bank_statement_imports_range_check" CHECK (("bank_statement_imports"."posted_from" IS NULL) = ("bank_statement_imports"."posted_to" IS NULL) AND ("bank_statement_imports"."posted_from" IS NULL OR "bank_statement_imports"."posted_from" <= "bank_statement_imports"."posted_to")),
	CONSTRAINT "bank_statement_imports_sha_check" CHECK ("bank_statement_imports"."file_sha256" ~ '^[a-f0-9]{64}$'),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_statement_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_statement_imports_account_fk" FOREIGN KEY ("tenant_id","bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid,
	"type" varchar(30) NOT NULL,
	"difference_idr" bigint NOT NULL,
	"owner_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"refs" jsonb NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" varchar(500),
	"adjustment_journal_entry_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" varchar(100),
	CONSTRAINT "bank_reconciliation_cases_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_reconciliation_cases_type_check" CHECK ("bank_reconciliation_cases"."type" IN ('bank_statement','gateway_settlement','edc_settlement','cash_deposit')),
	CONSTRAINT "bank_reconciliation_cases_status_check" CHECK ("bank_reconciliation_cases"."status" IN ('open','in_progress','resolved','written_off')),
	CONSTRAINT "bank_reconciliation_cases_difference_check" CHECK ("bank_reconciliation_cases"."difference_idr" <> 0),
	CONSTRAINT "bank_reconciliation_cases_refs_check" CHECK (jsonb_typeof("bank_reconciliation_cases"."refs") = 'array' AND jsonb_array_length("bank_reconciliation_cases"."refs") BETWEEN 1 AND 50),
	CONSTRAINT "bank_reconciliation_cases_resolution_check" CHECK (("bank_reconciliation_cases"."status" IN ('resolved','written_off')) = ("bank_reconciliation_cases"."resolved_by" IS NOT NULL AND "bank_reconciliation_cases"."resolved_at" IS NOT NULL AND "bank_reconciliation_cases"."resolution_note" IS NOT NULL)),
	CONSTRAINT "bank_reconciliation_cases_write_off_check" CHECK (("bank_reconciliation_cases"."status" = 'written_off') = ("bank_reconciliation_cases"."adjustment_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "bank_reconciliation_cases_version_check" CHECK ("bank_reconciliation_cases"."version" >= 1),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_reconciliation_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_reconciliation_cases_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_reconciliation_cases_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_reconciliation_cases_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"action" varchar(20) NOT NULL,
	"actor_id" text NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"from_owner_id" text,
	"to_owner_id" text NOT NULL,
	"note" varchar(500),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_case_events_seq_key" UNIQUE("tenant_id","case_id","seq"),
	CONSTRAINT "bank_reconciliation_case_events_action_check" CHECK ("bank_reconciliation_case_events"."action" IN ('open','start','reassign','resolve','write_off')),
	CONSTRAINT "bank_reconciliation_case_events_seq_check" CHECK ("bank_reconciliation_case_events"."seq" >= 1 AND (("bank_reconciliation_case_events"."action" = 'open') = ("bank_reconciliation_case_events"."seq" = 1)) AND (("bank_reconciliation_case_events"."action" = 'open') = ("bank_reconciliation_case_events"."from_status" IS NULL))),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_reconciliation_case_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_reconciliation_case_events_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."bank_reconciliation_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"posted_on" date NOT NULL,
	"amount_idr" bigint NOT NULL,
	"description" varchar(255) NOT NULL,
	"external_ref" varchar(100),
	"dedupe_key" varchar(400) NOT NULL,
	"match_status" varchar(20) DEFAULT 'unmatched' NOT NULL,
	"reconciliation_case_id" uuid,
	"excluded_reason" varchar(200),
	"status_changed_by" text,
	"status_changed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_statement_lines_account_id_key" UNIQUE("tenant_id","bank_account_id","id"),
	CONSTRAINT "bank_statement_lines_dedupe_key" UNIQUE("tenant_id","bank_account_id","dedupe_key"),
	CONSTRAINT "bank_statement_lines_amount_check" CHECK ("bank_statement_lines"."amount_idr" <> 0),
	CONSTRAINT "bank_statement_lines_status_check" CHECK ("bank_statement_lines"."match_status" IN ('unmatched','auto_matched','manually_matched','in_case','excluded')),
	CONSTRAINT "bank_statement_lines_excluded_check" CHECK (("bank_statement_lines"."match_status" = 'excluded') = ("bank_statement_lines"."excluded_reason" IS NOT NULL)),
	CONSTRAINT "bank_statement_lines_case_check" CHECK (("bank_statement_lines"."match_status" = 'in_case') = ("bank_statement_lines"."reconciliation_case_id" IS NOT NULL)),
	CONSTRAINT "bank_statement_lines_text_check" CHECK (char_length(btrim("bank_statement_lines"."description")) >= 1 AND char_length("bank_statement_lines"."dedupe_key") >= 1),
	CONSTRAINT "bank_statement_lines_version_check" CHECK ("bank_statement_lines"."version" >= 1),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_statement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_statement_lines_import_fk" FOREIGN KEY ("tenant_id","bank_account_id","import_id") REFERENCES "public"."bank_statement_imports"("tenant_id","bank_account_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_statement_lines_case_fk" FOREIGN KEY ("tenant_id","reconciliation_case_id") REFERENCES "public"."bank_reconciliation_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_statement_line_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"ref_type" varchar(30) NOT NULL,
	"ref_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"source" varchar(10) NOT NULL,
	"matched_by" text NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_line_matches_ref_key" UNIQUE("tenant_id","ref_type","ref_id"),
	CONSTRAINT "bank_statement_line_matches_ref_type_check" CHECK ("bank_statement_line_matches"."ref_type" IN ('journal_entry','cash_deposit','gateway_settlement','edc_settlement','supplier_payment','bank_statement_line')),
	CONSTRAINT "bank_statement_line_matches_source_check" CHECK ("bank_statement_line_matches"."source" IN ('auto','manual')),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_statement_line_matches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_statement_line_matches_line_fk" FOREIGN KEY ("tenant_id","bank_account_id","line_id") REFERENCES "public"."bank_statement_lines"("tenant_id","bank_account_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "bank_statement_match_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"ref_type" varchar(30) NOT NULL,
	"ref_id" uuid NOT NULL,
	"rejected_by" text NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_match_rejections_pair_key" UNIQUE("tenant_id","line_id","ref_type","ref_id"),
	CONSTRAINT "bank_statement_match_rejections_ref_type_check" CHECK ("bank_statement_match_rejections"."ref_type" IN ('journal_entry','cash_deposit','gateway_settlement','edc_settlement','supplier_payment','bank_statement_line')),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "bank_statement_match_rejections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bank_statement_match_rejections_line_fk" FOREIGN KEY ("tenant_id","bank_account_id","line_id") REFERENCES "public"."bank_statement_lines"("tenant_id","bank_account_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "cash_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"covers_from" date NOT NULL,
	"covers_to" date NOT NULL,
	"deposited_at" timestamp with time zone NOT NULL,
	"deposited_by" text NOT NULL,
	"slip_reference" varchar(60),
	"bank_statement_line_id" uuid,
	"reconciliation_case_id" uuid,
	"journal_entry_id" uuid,
	"status" varchar(20) DEFAULT 'recorded' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_deposits_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_deposits_amount_check" CHECK ("cash_deposits"."amount_idr" > 0),
	CONSTRAINT "cash_deposits_covers_check" CHECK ("cash_deposits"."covers_from" <= "cash_deposits"."covers_to"),
	CONSTRAINT "cash_deposits_status_check" CHECK ("cash_deposits"."status" IN ('recorded','matched','discrepancy')),
	CONSTRAINT "cash_deposits_matched_check" CHECK (("cash_deposits"."status" = 'matched') = ("cash_deposits"."bank_statement_line_id" IS NOT NULL)),
	CONSTRAINT "cash_deposits_discrepancy_check" CHECK (("cash_deposits"."status" = 'discrepancy') = ("cash_deposits"."reconciliation_case_id" IS NOT NULL)),
	CONSTRAINT "cash_deposits_version_check" CHECK ("cash_deposits"."version" >= 1),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): inside CREATE TABLE no validation
	-- scan runs under the FORCE RLS parents' policies.
	CONSTRAINT "cash_deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_bank_account_fk" FOREIGN KEY ("tenant_id","legal_entity_id","bank_account_id") REFERENCES "public"."bank_accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_statement_line_fk" FOREIGN KEY ("tenant_id","bank_account_id","bank_statement_line_id") REFERENCES "public"."bank_statement_lines"("tenant_id","bank_account_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_case_fk" FOREIGN KEY ("tenant_id","reconciliation_case_id") REFERENCES "public"."bank_reconciliation_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "cash_deposits_journal_fk" FOREIGN KEY ("tenant_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_cases_adjustment_key" ON "bank_reconciliation_cases" USING btree ("tenant_id","adjustment_journal_entry_id") WHERE "bank_reconciliation_cases"."adjustment_journal_entry_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "bank_reconciliation_cases_status_idx" ON "bank_reconciliation_cases" USING btree ("tenant_id","legal_entity_id","status","opened_at");
--> statement-breakpoint
CREATE INDEX "bank_statement_imports_account_idx" ON "bank_statement_imports" USING btree ("tenant_id","bank_account_id","imported_at");
--> statement-breakpoint
CREATE INDEX "bank_statement_line_matches_line_idx" ON "bank_statement_line_matches" USING btree ("tenant_id","line_id");
--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_posted_idx" ON "bank_statement_lines" USING btree ("tenant_id","bank_account_id","posted_on","id");
--> statement-breakpoint
CREATE INDEX "bank_statement_lines_status_idx" ON "bank_statement_lines" USING btree ("tenant_id","bank_account_id","match_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "cash_deposits_journal_key" ON "cash_deposits" USING btree ("tenant_id","journal_entry_id") WHERE "cash_deposits"."journal_entry_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "cash_deposits_outlet_idx" ON "cash_deposits" USING btree ("tenant_id","legal_entity_id","outlet_id","deposited_at");
--> statement-breakpoint
CREATE INDEX "cash_deposits_account_status_idx" ON "cash_deposits" USING btree ("tenant_id","bank_account_id","status");
--> statement-breakpoint
-- Cash & bank (bead legend-fnxl, WS-07; PRD v1.7 §3.19 Kas & Bank; ACC-04,
-- ACC-05). Tenant RLS on every table (TEN-01/02). cash_deposits is
-- outlet-owned (outlet_id NOT NULL), so it also gets the outlet policy
-- (TEN-03, guard src/db/outlet-rls.test.ts). bank accounts, imports, lines and
-- matches belong to a legal entity, and cases have a nullable outlet: outlet
-- reach on those is enforced in services/accounting-*.ts (contracts.md
-- "TEN-03 outlet isolation layers"), like the other accounting tables.
SELECT app.enforce_tenant_rls('public.bank_accounts'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_imports'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_reconciliation_cases'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_reconciliation_case_events'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_line_matches'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.bank_statement_match_rejections'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.cash_deposits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_deposits'::regclass);
--> statement-breakpoint
-- The case action log is append-only for the application role: a correction
-- is a new action, never an edited or deleted one.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.bank_reconciliation_case_events FROM legend_app;
