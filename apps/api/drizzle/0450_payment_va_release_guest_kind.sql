-- legend-9vmit (founder Q15): a guest may change payment method; the old VA or
-- bank transfer code is voided by the system first. The void reuses the VA
-- release row (the durable queue that keeps asking the provider and parks any
-- late money as unallocated funds), but has no staff, no approval and no
-- override. `kind` tells the two apart; the actor columns become nullable and
-- one CHECK ties them to the kind, so a staff release can never lose its
-- approval and a guest void can never carry a borrowed one. No FK is added
-- (existing table; no ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY).
ALTER TABLE "payment_va_releases" ADD COLUMN "kind" text DEFAULT 'staff' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_va_releases" ALTER COLUMN "released_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_va_releases" ALTER COLUMN "approved_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_va_releases" ALTER COLUMN "override_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_va_releases" ADD CONSTRAINT "payment_va_releases_kind_check" CHECK ("payment_va_releases"."kind" IN ('staff', 'guest_method_change'));
--> statement-breakpoint
ALTER TABLE "payment_va_releases" ADD CONSTRAINT "payment_va_releases_kind_actor_check" CHECK (("payment_va_releases"."kind" = 'staff' AND "payment_va_releases"."released_by" IS NOT NULL AND "payment_va_releases"."approved_by" IS NOT NULL AND "payment_va_releases"."override_id" IS NOT NULL) OR ("payment_va_releases"."kind" = 'guest_method_change' AND "payment_va_releases"."released_by" IS NULL AND "payment_va_releases"."approved_by" IS NULL AND "payment_va_releases"."override_id" IS NULL));
