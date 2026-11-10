-- Per-requester approver-PIN window (bead legend-vfj7z). Number 0236
-- (was 0258 on the branch, renumbered by the merge train). One new empty table with the
-- foreign keys inside CREATE TABLE (docs/plan/contracts.md pattern 1: no
-- validation scan), then tenant RLS.
CREATE TABLE "user_pin_throttle" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"alerted_window_started_at" timestamp with time zone,
	CONSTRAINT "user_pin_throttle_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "user_pin_throttle_failures_check" CHECK ("user_pin_throttle"."failures" >= 0),
	CONSTRAINT "user_pin_throttle_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "user_pin_throttle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.user_pin_throttle'::regclass);
--> statement-breakpoint
