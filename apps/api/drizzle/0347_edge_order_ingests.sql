CREATE TABLE "edge_order_ingests" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"paid_event_id" uuid NOT NULL,
	"state" varchar(20) NOT NULL,
	"reason" text,
	"void_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_order_ingests_tenant_id_order_id_pk" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "edge_order_ingests_state_check" CHECK ("edge_order_ingests"."state" IN ('ingested', 'cancelled', 'voided', 'refused')),
	CONSTRAINT "edge_order_ingests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_order_ingests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "edge_order_ingests_outlet_idx" ON "edge_order_ingests" USING btree ("tenant_id","outlet_id","created_at");--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_order_ingests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_order_ingests'::regclass);
