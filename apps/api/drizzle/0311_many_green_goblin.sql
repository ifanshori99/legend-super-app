CREATE TABLE "loyalty_earn_parked" (
	"tenant_id" uuid NOT NULL,
	"event_id" varchar(80) NOT NULL,
	"order_id" uuid NOT NULL,
	"event_name" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_earn_parked_tenant_event_key" UNIQUE("tenant_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "loyalty_earn_parked" ADD CONSTRAINT "loyalty_earn_parked_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_earn_parked_order_idx" ON "loyalty_earn_parked" USING btree ("tenant_id","order_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.loyalty_earn_parked'::regclass);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.loyalty_earn_parked FROM legend_app;
