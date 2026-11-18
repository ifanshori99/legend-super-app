CREATE TABLE "customer_reviews" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid,
	"reservation_id" uuid,
	"customer_profile_id" uuid,
	"rating" integer NOT NULL,
	"body" varchar(2000),
	"source" varchar(16) NOT NULL,
	"moderation_status" varchar(12) DEFAULT 'pending' NOT NULL,
	"moderated_by" text,
	"moderated_at" timestamp with time zone,
	"moderation_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_reviews_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "customer_reviews_rating_check" CHECK ("customer_reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "customer_reviews_source_check" CHECK ("customer_reviews"."source" IN ('qr', 'app', 'web', 'google', 'manual')),
	CONSTRAINT "customer_reviews_moderation_status_check" CHECK ("customer_reviews"."moderation_status" IN ('pending', 'published', 'hidden')),
	CONSTRAINT "customer_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_reviews_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_reviews_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_reviews_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "customer_reviews_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "customer_reviews_queue_idx" ON "customer_reviews" USING btree ("tenant_id","outlet_id","moderation_status","created_at");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.customer_reviews'::regclass);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.customer_reviews FROM legend_app;
