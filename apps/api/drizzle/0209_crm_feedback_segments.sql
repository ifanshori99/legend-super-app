CREATE TABLE "feedback" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_session_id" uuid,
	"customer_profile_id" uuid,
	"order_id" uuid,
	"kind" varchar(12) NOT NULL,
	"rating" integer,
	"comment" varchar(2000),
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"handled_by" text,
	"handled_note" varchar(2000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "feedback_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "feedback_order_profile_kind_key" UNIQUE("tenant_id","order_id","customer_profile_id","kind"),
	CONSTRAINT "feedback_kind_check" CHECK ("feedback"."kind" IN ('rating', 'complaint')),
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" IN ('open', 'in_review', 'resolved', 'closed')),
	CONSTRAINT "feedback_rating_check" CHECK ("feedback"."rating" IS NULL OR "feedback"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "feedback_kind_shape_check" CHECK (CASE WHEN "feedback"."kind" = 'rating'
               THEN "feedback"."rating" IS NOT NULL
               ELSE "feedback"."comment" IS NOT NULL END),
	CONSTRAINT "feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "feedback_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "feedback_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "feedback_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "feedback_table_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"definition" jsonb NOT NULL,
	"refreshed_at" timestamp with time zone,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "segment_members" (
	"tenant_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"materialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_members_pkey" PRIMARY KEY("tenant_id","segment_id","customer_profile_id"),
	CONSTRAINT "segment_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "segment_members_segment_fk" FOREIGN KEY ("tenant_id","segment_id") REFERENCES "public"."segments"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "segment_members_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_session_profile_kind_key" ON "feedback" USING btree ("tenant_id","table_session_id","customer_profile_id","kind") WHERE "feedback"."order_id" IS NULL AND "feedback"."table_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "feedback_queue_idx" ON "feedback" USING btree ("tenant_id","outlet_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "feedback_profile_idx" ON "feedback" USING btree ("tenant_id","customer_profile_id","created_at");
--> statement-breakpoint
CREATE INDEX "segment_members_profile_idx" ON "segment_members" USING btree ("tenant_id","customer_profile_id");
--> statement-breakpoint
CREATE INDEX "segments_tenant_name_idx" ON "segments" USING btree ("tenant_id","name");
--> statement-breakpoint
-- legend-ts50: hand SQL of migration 0209 (tables in crm-feedback.ts and
-- crm-segments.ts). Keep this file and the migration in step. The generated
-- CREATE TABLE statements carry every foreign key inline (pattern 1,
-- docs/plan/contracts.md: the new tables are empty, so FORCE RLS needs no
-- lift). 0209 changes no data and lifts no FORCE.
SELECT app.enforce_tenant_rls('public.feedback'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.feedback'::regclass);
--> statement-breakpoint
-- Member RLS (design §M4): a member reads only feedback of their own profile.
-- Rows with a NULL profile (QR guests) never match, so members cannot see
-- them. Staff and worker paths never set app.customer_profile_id, so the
-- RESTRICTIVE policy is inert for them.
SELECT app.enforce_member_rls('public.feedback'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.segments'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.segment_members'::regclass);
--> statement-breakpoint
-- Feedback and segments are never deleted: feedback moves through its status
-- and a segment is refreshed in place. segment_members keeps DELETE so a
-- refresh can replace the materialized rows.
REVOKE DELETE, TRUNCATE ON TABLE public.feedback FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.segments FROM legend_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE public.segment_members FROM legend_app;
