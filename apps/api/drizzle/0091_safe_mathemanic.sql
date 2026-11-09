CREATE TABLE "promo_command_idempotency" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_command_idempotency_pkey" PRIMARY KEY("tenant_id","key"),
	CONSTRAINT "promo_command_idempotency_fingerprint_check" CHECK ("promo_command_idempotency"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "outlet_scope" varchar(12) DEFAULT 'all_except' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_command_idempotency" ADD CONSTRAINT "promo_command_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_outlet_scope_check" CHECK ("promotions"."outlet_scope" IN ('all_except', 'only'));