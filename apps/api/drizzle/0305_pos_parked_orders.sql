-- Declare FKs inline on this empty new table so a plain migration owner does
-- not validate them with ALTER TABLE against already FORCE-RLS parents.
CREATE TABLE "pos_parked_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"label" varchar(150) NOT NULL,
	"parked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "pos_parked_orders_create_intent_key" UNIQUE("tenant_id","outlet_id","creator_user_id","idempotency_key"),
	CONSTRAINT "pos_parked_orders_snapshot_check" CHECK (jsonb_typeof("pos_parked_orders"."snapshot") = 'object' AND jsonb_typeof("pos_parked_orders"."snapshot"->'items') = 'array'),
	CONSTRAINT "pos_parked_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_parked_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_parked_orders_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_parked_orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_parked_orders_active_creator_idx" ON "pos_parked_orders" USING btree ("tenant_id","outlet_id","creator_user_id","parked_at","id") WHERE "pos_parked_orders"."consumed_at" IS NULL;
--> statement-breakpoint
-- Append after the generated pos_parked_orders table/index DDL.
SELECT app.enforce_tenant_rls('public.pos_parked_orders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_parked_orders'::regclass);
--> statement-breakpoint
-- Raw snapshots and replay keys are immutable; resume only sets consumed_at.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.pos_parked_orders FROM legend_app;
--> statement-breakpoint
GRANT UPDATE (consumed_at) ON TABLE public.pos_parked_orders TO legend_app;
