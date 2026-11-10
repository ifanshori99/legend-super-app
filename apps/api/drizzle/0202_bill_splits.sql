-- legend-ms3: bill_splits. Foreign keys sit inside CREATE TABLE (docs/plan/contracts.md
-- "Migrations: foreign keys into FORCE RLS tables", pattern 1): no validation scan runs
-- on the new empty table. The one ALTER (payment_intents -> bill_splits) is pattern 2:
-- payment_intents FORCEs RLS, so lift FORCE for this transaction and restore it
-- right after. bill_splits has no RLS yet at that point (it follows below).
CREATE TABLE "bill_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"split_set_id" uuid NOT NULL,
	"method" varchar(20) NOT NULL,
	"share_index" smallint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"label" varchar(150),
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"participant_id" uuid,
	"payment_intent_id" uuid,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"claim_token_hash" varchar(64),
	"claim_token_sealed" text,
	"claim_expires_at" timestamp with time zone,
	"claim_redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_splits_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "bill_splits_claim_token_hash_key" UNIQUE("claim_token_hash"),
	CONSTRAINT "bill_splits_set_index_key" UNIQUE("tenant_id","split_set_id","share_index"),
	CONSTRAINT "bill_splits_amount_check" CHECK ("bill_splits"."amount_idr" > 0),
	CONSTRAINT "bill_splits_status_check" CHECK ("bill_splits"."status" IN ('pending', 'paid', 'voided')),
	CONSTRAINT "bill_splits_method_check" CHECK ("bill_splits"."method" IN ('equal', 'by_item', 'by_person')),
	CONSTRAINT "bill_splits_paid_at_check" CHECK (("bill_splits"."status" = 'paid') = ("bill_splits"."paid_at" IS NOT NULL)),
	CONSTRAINT "bill_splits_voided_at_check" CHECK (("bill_splits"."status" = 'voided') = ("bill_splits"."voided_at" IS NOT NULL)),
	CONSTRAINT "bill_splits_by_item_check" CHECK (("bill_splits"."method" = 'by_item') = (cardinality("bill_splits"."item_ids") > 0)),
	CONSTRAINT "bill_splits_by_person_check" CHECK ("bill_splits"."method" <> 'by_person' OR "bill_splits"."participant_id" IS NOT NULL),
	CONSTRAINT "bill_splits_claim_paid_check" CHECK ("bill_splits"."claim_token_hash" IS NULL OR "bill_splits"."status" = 'paid'),
	CONSTRAINT "bill_splits_claim_redeemed_check" CHECK ("bill_splits"."claim_redeemed_at" IS NULL OR "bill_splits"."claim_token_hash" IS NOT NULL),
	CONSTRAINT "bill_splits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bill_splits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bill_splits_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bill_splits_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bill_splits_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "bill_splits_participant_fk" FOREIGN KEY ("tenant_id","participant_id") REFERENCES "public"."session_participants"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bill_splits_live_index_key" ON "bill_splits" USING btree ("tenant_id","order_id","share_index") WHERE "bill_splits"."status" <> 'voided';
--> statement-breakpoint
CREATE INDEX "bill_splits_session_idx" ON "bill_splits" USING btree ("tenant_id","table_session_id","created_at");
--> statement-breakpoint
ALTER TABLE public.payment_intents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_bill_split_fk" FOREIGN KEY ("tenant_id","bill_split_id") REFERENCES "public"."bill_splits"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.payment_intents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Custom SQL migration file, put your code below! ---
-- legend-ms3 bill_splits: tenant-owned AND outlet-owned (outlet_id NOT NULL), so
-- it gets the RESTRICTIVE tenant policy and, right after it, the outlet policy
-- (TEN-03, guard test src/db/outlet-rls.test.ts), same as orders.
SELECT app.enforce_tenant_rls('public.bill_splits'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.bill_splits'::regclass);
