-- legend-6vgv: the outlet a staff session pinned for outlet-less routes
-- (/api/floor, zones, tables, layout). One row per (session, tenant), written
-- by PUT /api/me/active-outlet after the server checked the outlet is inside
-- the caller's reach. Additive: one new empty table, no data statement.
CREATE TABLE "session_active_outlets" (
	"session_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_active_outlets_pk" PRIMARY KEY("session_id","tenant_id"),
	-- Foreign keys inline (docs/plan/contracts.md "Migrations: foreign keys
	-- into FORCE RLS tables", pattern 1): an ALTER TABLE ... ADD FOREIGN KEY
	-- validates under the FORCE RLS parent's policy and aborts the migration
	-- without app.tenant_id. Inside CREATE TABLE no validation scan runs.
	CONSTRAINT "session_active_outlets_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "session_active_outlets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "session_active_outlets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "session_active_outlets_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Tenant-owned AND outlet-owned (outlet_id NOT NULL): the RESTRICTIVE tenant
-- policy, then the outlet policy right after it (TEN-03, guard test
-- src/db/outlet-rls.test.ts).
SELECT app.enforce_tenant_rls('public.session_active_outlets'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.session_active_outlets'::regclass);
