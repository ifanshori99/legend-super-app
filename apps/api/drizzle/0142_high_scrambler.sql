ALTER TABLE "staff_pins" ADD COLUMN "pin_generation_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- legend-kyie (Codex 160 C1) backfill: the current generation's order key is
-- its set time. staff_pins is FORCE RLS and the migration role is a non-super
-- table owner with no tenant context, so FORCE is lifted for this statement
-- only (same pattern as 0096 / 0141) and restored in the same transaction.
ALTER TABLE "staff_pins" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "staff_pins" SET "pin_generation_at" = "pin_set_at";
--> statement-breakpoint
ALTER TABLE "staff_pins" FORCE ROW LEVEL SECURITY;
