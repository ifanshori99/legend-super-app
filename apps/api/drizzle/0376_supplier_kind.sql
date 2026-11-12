ALTER TABLE "suppliers" ADD COLUMN "kind" varchar(20) DEFAULT 'goods' NOT NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_kind_check" CHECK ("suppliers"."kind" IN ('goods', 'maintenance'));
