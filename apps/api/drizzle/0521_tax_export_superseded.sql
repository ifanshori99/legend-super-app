ALTER TABLE "payroll_tax_exports" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_tax_exports" ADD COLUMN "superseded_reason" text;