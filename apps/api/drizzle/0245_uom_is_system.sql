ALTER TABLE "uoms" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "uoms" SET "is_system" = true WHERE "code" IN ('kg', 'g', 'l', 'ml', 'pcs', 'pack', 'ctn', 'btl', 'can', 'sachet', 'box', 'porsi');
