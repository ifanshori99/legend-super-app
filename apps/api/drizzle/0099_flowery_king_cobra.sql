CREATE TABLE "cash_movement_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_refusals_idempotency_key" UNIQUE("tenant_id","shift_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_reason_check";--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_refusals" ADD CONSTRAINT "cash_movement_refusals_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK (char_length(btrim("cash_movements"."reason_note")) >= 4) NOT VALID;--> statement-breakpoint
-- NOT VALID: new rows must pass btrim; rows written before this migration are
-- not re-checked (a whitespace-only reason may already exist and movements are
-- append-only history, so it cannot be fixed by an UPDATE).

-- Tenant + outlet RLS (TEN-01/TEN-03) for the refusal idempotency record.
SELECT app.enforce_tenant_rls('public.cash_movement_refusals'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.cash_movement_refusals'::regclass);