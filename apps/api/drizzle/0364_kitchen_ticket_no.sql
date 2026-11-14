-- legend-tzyj2: running ticket number per outlet and business day. The KDS
-- scan code (K-001) and the printed slip read it; `business_date` is the
-- outlet business day of `fired_at` (zone + cutoff of the outlet, as
-- businessDateOf in @starter/shared/core: wall clock minus the cutoff, then
-- the date). Existing tickets are numbered 1.. per (tenant, outlet,
-- business_date) by fired_at, then id.
ALTER TABLE "kitchen_tickets" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "ticket_no" integer;--> statement-breakpoint
-- kitchen_tickets and outlets are FORCE RLS and the migrator is a table owner
-- with no tenant context, so lift FORCE for this transaction only and restore
-- it before commit, as in 0348 and 0590. Without FORCE the owner skips RLS,
-- so the backfill spans every tenant.
ALTER TABLE public.kitchen_tickets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.outlets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.kitchen_tickets t
SET business_date = d.business_date,
    ticket_no = d.ticket_no
FROM (
  SELECT k.id,
         x.business_date,
         row_number() OVER (
           PARTITION BY k.tenant_id, k.outlet_id, x.business_date
           ORDER BY k.fired_at, k.id
         )::integer AS ticket_no
  FROM public.kitchen_tickets k
  JOIN public.outlets o ON o.tenant_id = k.tenant_id AND o.id = k.outlet_id
  CROSS JOIN LATERAL (
    SELECT ((k.fired_at AT TIME ZONE o.timezone) - o.business_day_cutoff::interval)::date AS business_date
  ) x
) d
WHERE d.id = t.id;--> statement-breakpoint
ALTER TABLE public.outlets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.kitchen_tickets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ALTER COLUMN "ticket_no" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_tickets_outlet_day_ticket_no_key" ON "kitchen_tickets" USING btree ("tenant_id","outlet_id","business_date","ticket_no");
