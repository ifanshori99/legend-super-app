-- FKs are declared inline on these empty new tables so a plain migration owner
-- does not validate them with ALTER TABLE against already FORCE-RLS parents.
CREATE TABLE "panic_receiver_sessions" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"pin_generation_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "panic_receiver_sessions_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "panic_receiver_sessions_token_hash_check" CHECK (octet_length("panic_receiver_sessions"."token_hash") = 32),
	CONSTRAINT "panic_receiver_sessions_revoke_reason_check" CHECK ("panic_receiver_sessions"."revoke_reason" IS NULL OR "panic_receiver_sessions"."revoke_reason" IN ('logout', 'replaced', 'pin_changed', 'staff_inactive', 'permission_removed', 'device_revoked', 'off_duty', 'expired')),
	CONSTRAINT "panic_receiver_sessions_revoke_pair_check" CHECK (("panic_receiver_sessions"."revoked_at" IS NULL) = ("panic_receiver_sessions"."revoke_reason" IS NULL)),
	CONSTRAINT "panic_receiver_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_receiver_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "panic_receiver_sessions_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "panic_receiver_sessions_token_key" ON "panic_receiver_sessions" USING btree ("tenant_id","token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "panic_receiver_sessions_active_device_key" ON "panic_receiver_sessions" USING btree ("tenant_id","device_id") WHERE "panic_receiver_sessions"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "panic_receiver_sessions_outlet_user_idx" ON "panic_receiver_sessions" USING btree ("tenant_id","outlet_id","user_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.panic_receiver_sessions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.panic_receiver_sessions'::regclass);
