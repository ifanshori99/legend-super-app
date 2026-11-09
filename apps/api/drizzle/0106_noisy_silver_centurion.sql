-- legend-wg5t: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets and pos_shifts. Lift FORCE on those two for this
-- transaction only; it is restored right after the last foreign key, before
-- commit (drizzle applies pending migrations in one transaction, so no other
-- session ever sees the lifted state). tenants never had FORCE, so it is left
-- alone.
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pos_shifts NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
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
ALTER TABLE public.pos_shifts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK (char_length(btrim("cash_movements"."reason_note", E' \t\r\n')) >= 4) NOT VALID;--> statement-breakpoint
-- NOT VALID: new rows must pass btrim (spaces, tabs, newlines; code points); rows written before this migration are
-- not re-checked (a whitespace-only reason may already exist and movements are
-- append-only history, so it cannot be fixed by an UPDATE).
