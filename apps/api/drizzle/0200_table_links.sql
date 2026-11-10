CREATE TABLE "table_link_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dissolved_at" timestamp with time zone,
	"dissolved_reason" varchar(30),
	CONSTRAINT "table_link_groups_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "table_link_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_groups_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_groups_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "table_link_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" varchar(30),
	CONSTRAINT "table_link_members_left_reason_check" CHECK ("table_link_members"."left_reason" IS NULL OR "table_link_members"."left_reason" IN ('staff', 'session_closed', 'group_dissolved', 'session_merged')),
	CONSTRAINT "table_link_members_left_pair_check" CHECK (("table_link_members"."left_at" IS NULL) = ("table_link_members"."left_reason" IS NULL)),
	CONSTRAINT "table_link_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_members_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_members_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_members_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."table_link_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_members_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."tables"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "table_link_members_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "table_link_members_live_table_key" ON "table_link_members" USING btree ("tenant_id","table_id") WHERE "table_link_members"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "table_link_members_live_session_key" ON "table_link_members" USING btree ("tenant_id","table_session_id") WHERE "table_link_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "table_link_members_group_idx" ON "table_link_members" USING btree ("tenant_id","group_id");
--> statement-breakpoint
-- Tenant + outlet RLS (TEN-01/TEN-03). Both tables have outlet_id NOT NULL.
-- Groups and members are written by the API; a member keeps its row after it leaves.
SELECT app.enforce_tenant_rls('public.table_link_groups'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.table_link_groups'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.table_link_members'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.table_link_members'::regclass);
