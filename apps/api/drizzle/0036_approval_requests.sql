CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"chain_id" uuid NOT NULL,
	"source_module" varchar(50) NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"object_id" varchar(36) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"source" varchar(10) NOT NULL,
	"level" integer NOT NULL,
	"required_levels" integer NOT NULL,
	"required_steps" jsonb NOT NULL,
	"threshold_idr" bigint,
	"amount_idr" bigint,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"request_reason" varchar(500) NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" varchar(500),
	"decision_fingerprint" varchar(64),
	"decision_idempotency_key" varchar(100),
	"create_idempotency_key" varchar(100),
	"create_fingerprint" varchar(64),
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_requests_chain_level_key" UNIQUE("tenant_id","chain_id","level"),
	CONSTRAINT "approval_requests_status_check" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "approval_requests_source_check" CHECK ("approval_requests"."source" IN ('user', 'ai', 'mcp')),
	CONSTRAINT "approval_requests_level_check" CHECK ("approval_requests"."required_levels" BETWEEN 1 AND 3 AND "approval_requests"."level" BETWEEN 1 AND "approval_requests"."required_levels"),
	CONSTRAINT "approval_requests_chain_check" CHECK (("approval_requests"."level" = 1) = ("approval_requests"."chain_id" = "approval_requests"."id")),
	CONSTRAINT "approval_requests_amount_check" CHECK (("approval_requests"."amount_idr" IS NULL OR "approval_requests"."amount_idr" >= 0) AND ("approval_requests"."threshold_idr" IS NULL OR "approval_requests"."threshold_idr" >= 0)),
	CONSTRAINT "approval_requests_decision_check" CHECK (("approval_requests"."status" IN ('approved', 'rejected')) = ("approval_requests"."decided_by" IS NOT NULL AND "approval_requests"."decided_at" IS NOT NULL AND "approval_requests"."reason" IS NOT NULL)),
	CONSTRAINT "approval_requests_distinct_actor_check" CHECK ("approval_requests"."decided_by" IS NULL OR "approval_requests"."decided_by" <> "approval_requests"."requested_by"),
	CONSTRAINT "approval_requests_deadline_check" CHECK ("approval_requests"."deadline_at" > "approval_requests"."created_at"),
	CONSTRAINT "approval_requests_json_check" CHECK (jsonb_typeof("approval_requests"."payload") = 'object' AND jsonb_typeof("approval_requests"."required_steps") = 'array'),
	CONSTRAINT "approval_requests_reason_check" CHECK (char_length("approval_requests"."request_reason") >= 3 AND ("approval_requests"."reason" IS NULL OR char_length("approval_requests"."reason") >= 3))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_chain_fk" FOREIGN KEY ("tenant_id","chain_id") REFERENCES "public"."approval_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_key" ON "approval_requests" USING btree ("tenant_id","action_type","object_type","object_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_create_key" ON "approval_requests" USING btree ("tenant_id","requested_by","create_idempotency_key") WHERE "approval_requests"."create_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "approval_requests_due_idx" ON "approval_requests" USING btree ("tenant_id","deadline_at") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_inbox_idx" ON "approval_requests" USING btree ("tenant_id","created_at","id");