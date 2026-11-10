ALTER TABLE "staff_pins" ADD COLUMN "pin_set_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD COLUMN "apply_outcome" varchar(20);--> statement-breakpoint
CREATE INDEX "edge_deferred_events_pending_idx" ON "edge_deferred_events" USING btree ("tenant_id","outlet_id","aggregate_type","received_at","event_id") WHERE "edge_deferred_events"."applied_at" IS NULL;--> statement-breakpoint
ALTER TABLE "edge_deferred_events" ADD CONSTRAINT "edge_deferred_events_apply_outcome_check" CHECK (("edge_deferred_events"."apply_outcome" IS NULL OR "edge_deferred_events"."apply_outcome" IN ('applied', 'not_applicable', 'refused')) AND ("edge_deferred_events"."apply_outcome" IS NULL) = ("edge_deferred_events"."applied_at" IS NULL));--> statement-breakpoint
-- legend-kyie backfill: the current pin generation's set time is the row's
-- last version. staff_pins is FORCE RLS and the migration role is a non-super
-- table owner with no tenant context, so FORCE is lifted for this statement
-- only (same pattern as 0096) and restored in the same migration transaction.
ALTER TABLE "staff_pins" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "staff_pins" SET "pin_set_at" = "updated_at";
--> statement-breakpoint
ALTER TABLE "staff_pins" FORCE ROW LEVEL SECURITY;
