-- 936 second-opinion round 2 (R2-04, legend-0xt77): the door-check PIN guess
-- counter was process-local with a 10,000 key cap, so churn of unknown ticket
-- ids evicted a locked ticket and each instance counted alone. The counter now
-- lives in this table, shared by every instance, one row per real ticket, never
-- evicted. Foreign keys are inline (docs/plan/contracts.md "Migrations: foreign
-- keys into FORCE RLS tables", pattern 1); RLS as in 0671/0672.
-- New table, nothing else locks it; the wrapper bounds the FK checks against
-- tenants, outlets and access_tickets (wait at most 5s, then restore the
-- migrator's value; contracts.md, bead legend-76azz; same as 0672).
SELECT set_config('legend.lock_timeout_before_0676', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
CREATE TABLE "access_ticket_pin_guesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"access_ticket_id" uuid NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failures" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_ticket_pin_guesses_ticket_key" UNIQUE("tenant_id","access_ticket_id"),
	CONSTRAINT "access_ticket_pin_guesses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_pin_guesses_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_pin_guesses_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_pin_guesses_failures_check" CHECK ("access_ticket_pin_guesses"."failures" >= 0)
);
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/facility.custom.sql): tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.access_ticket_pin_guesses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.access_ticket_pin_guesses'::regclass);
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0676', true), ''), current_setting('lock_timeout')), true);
