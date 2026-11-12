ALTER TABLE "leave_requests" ADD COLUMN "rejection_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD COLUMN "rejection_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD COLUMN "rejection_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD COLUMN "peer_accepted_at" timestamp with time zone;
--> statement-breakpoint
-- Existing supervisor templates need the same shell entry as new tenants.
-- Custom roles and every other template remain unchanged.
ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.roles
SET permissions = permissions || '["dashboard.management.view"]'::jsonb
WHERE is_template AND template_key = 'supervisor'
  AND NOT permissions @> '["dashboard.management.view"]'::jsonb;
--> statement-breakpoint
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
