-- legend-o5gr: the migrator may be a plain table owner (no SUPERUSER, no
-- BYPASSRLS). FORCE ROW LEVEL SECURITY would apply the tenant policies to it,
-- and with no app.tenant_id set they raise 42501 while the foreign keys below
-- are validated against outlets and reservations. Lift FORCE for this
-- transaction only and restore it right after the constraints, before commit
-- (same pattern as 0065; drizzle applies pending migrations in one
-- transaction, so no other session ever sees the lifted state).
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reservations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "reservation_guest_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_guest_links_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservation_guest_links_token_key" UNIQUE("tenant_id","token_hash"),
	CONSTRAINT "reservation_guest_links_token_hash_check" CHECK ("reservation_guest_links"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "reservation_reschedule_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"guest_link_id" uuid,
	"requested_for" timestamp with time zone NOT NULL,
	"party_size" integer,
	"note" varchar(300),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "reservation_reschedule_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservation_reschedule_requests_status_check" CHECK ("reservation_reschedule_requests"."status" IN ('pending', 'approved', 'declined', 'withdrawn')),
	CONSTRAINT "reservation_reschedule_requests_party_size_check" CHECK ("reservation_reschedule_requests"."party_size" IS NULL OR ("reservation_reschedule_requests"."party_size" >= 1 AND "reservation_reschedule_requests"."party_size" <= 50))
);
--> statement-breakpoint
ALTER TABLE "reservation_guest_links" ADD CONSTRAINT "reservation_guest_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_guest_links" ADD CONSTRAINT "reservation_guest_links_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_guest_links" ADD CONSTRAINT "reservation_guest_links_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_guest_links" ADD CONSTRAINT "reservation_guest_links_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_reschedule_requests" ADD CONSTRAINT "reservation_reschedule_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_reschedule_requests" ADD CONSTRAINT "reservation_reschedule_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_reschedule_requests" ADD CONSTRAINT "reservation_reschedule_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_reschedule_requests" ADD CONSTRAINT "reservation_reschedule_requests_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_reschedule_requests" ADD CONSTRAINT "reservation_reschedule_requests_link_fk" FOREIGN KEY ("tenant_id","guest_link_id") REFERENCES "public"."reservation_guest_links"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_guest_links_active_key" ON "reservation_guest_links" USING btree ("tenant_id","reservation_id") WHERE "reservation_guest_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_reschedule_requests_pending_key" ON "reservation_reschedule_requests" USING btree ("tenant_id","reservation_id") WHERE "reservation_reschedule_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reservation_reschedule_requests_list_idx" ON "reservation_reschedule_requests" USING btree ("tenant_id","outlet_id","status","created_at");
--> statement-breakpoint
ALTER TABLE public.reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Custom SQL migration for legend-o5gr (guest reservation self-service).
-- Append AFTER the drizzle-generated CREATE TABLE statements for
-- reservation_guest_links and reservation_reschedule_requests.
--
-- Tenant RLS (FORCE) on both tables: a guest link is looked up by
-- (tenant from the request host, token_hash), so another tenant's token is
-- invisible, never a hint that it exists.
SELECT app.enforce_tenant_rls('public.reservation_guest_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_reschedule_requests'::regclass);
--> statement-breakpoint
-- Outlet RLS too, like every reservation table (outlet_id is NOT NULL): an
-- outlet-scoped staff session sees only its outlets' links and requests; the
-- tenant-wide guest context passes through app.outlet_scope_is_tenant().
SELECT app.enforce_outlet_rls('public.reservation_guest_links'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_reschedule_requests'::regclass);
