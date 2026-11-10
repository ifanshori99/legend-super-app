-- Outlet-device attendance PIN proofs (bead legend-u7g9w). Provisional number
-- 0241, renumbered by the merge train if taken. Two new empty tables, with the
-- foreign keys inside CREATE TABLE (docs/plan/contracts.md pattern 1: no
-- validation scan, so a plain non-superuser migrator needs no FORCE RLS lift),
-- then core_storage_objects.pin_proof_id. That table FORCEs tenant RLS, so the
-- ALTER lifts FORCE for this transaction only and restores it right after
-- (same pattern as 0159 and 0177). The enforce_* calls on the new tables run
-- last, after that FK is validated.
CREATE TABLE "device_pin_throttle" (
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"alerted_window_started_at" timestamp with time zone,
	CONSTRAINT "device_pin_throttle_tenant_id_device_id_pk" PRIMARY KEY("tenant_id","device_id"),
	CONSTRAINT "device_pin_throttle_failures_check" CHECK ("device_pin_throttle"."failures" >= 0),
	CONSTRAINT "device_pin_throttle_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "device_pin_throttle_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "staff_pin_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_pin_proofs_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "staff_pin_proofs_purpose_check" CHECK ("staff_pin_proofs"."purpose" IN ('attendance_clock')),
	CONSTRAINT "staff_pin_proofs_token_hash_check" CHECK (octet_length("staff_pin_proofs"."token_hash") = 32),
	CONSTRAINT "staff_pin_proofs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "staff_pin_proofs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "staff_pin_proofs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "staff_pin_proofs_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "staff_pin_proofs_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "staff_pin_proofs_device_idx" ON "staff_pin_proofs" USING btree ("tenant_id","device_id");
--> statement-breakpoint
-- core_storage_objects.pin_proof_id comes BEFORE the enforce_* calls below: the
-- FK is validated against staff_pin_proofs, and once FORCE RLS is on there a
-- migrator without BYPASSRLS has no tenant context ("tenant context is
-- required"). staff_pin_proofs is still empty and unforced at this point.
ALTER TABLE public.core_storage_objects NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD COLUMN "pin_proof_id" uuid;
--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_pin_proof_id_staff_pin_proofs_id_fk" FOREIGN KEY ("pin_proof_id") REFERENCES "public"."staff_pin_proofs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.core_storage_objects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- device_pin_throttle: tenant RLS only. staff_pin_proofs: tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.device_pin_throttle'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.staff_pin_proofs'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.staff_pin_proofs'::regclass);
--> statement-breakpoint
