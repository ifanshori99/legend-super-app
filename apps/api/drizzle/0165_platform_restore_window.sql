ALTER TABLE "outlets" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "status_before_close" varchar(20);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_before_archive" varchar(20);--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_status_before_close_check" CHECK ("outlets"."status_before_close" IS NULL OR "outlets"."status_before_close" IN ('preopening', 'active'));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_close_record_check" CHECK (("outlets"."closed_at" IS NULL) = ("outlets"."status_before_close" IS NULL));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_before_archive_check" CHECK ("tenants"."status_before_archive" IS NULL OR "tenants"."status_before_archive" IN ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_archive_record_check" CHECK (("tenants"."archived_at" IS NULL) = ("tenants"."status_before_archive" IS NULL));