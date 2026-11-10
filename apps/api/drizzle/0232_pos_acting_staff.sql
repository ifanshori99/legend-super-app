CREATE TABLE "pos_acting_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	"session_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(20),
	CONSTRAINT "pos_acting_staff_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "pos_acting_staff_ttl_check" CHECK ("pos_acting_staff"."expires_at" <= "pos_acting_staff"."issued_at" + interval '12 hours'),
	CONSTRAINT "pos_acting_staff_revoke_check" CHECK (("pos_acting_staff"."revoked_at" IS NULL) = ("pos_acting_staff"."revoke_reason" IS NULL)),
	CONSTRAINT "pos_acting_staff_revoke_reason_check" CHECK ("pos_acting_staff"."revoke_reason" IS NULL OR "pos_acting_staff"."revoke_reason" IN ('switched', 'ended', 'shift_closed', 'day_closed', 'pin_reset', 'staff_inactive')),
	CONSTRAINT "pos_acting_staff_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_acting_staff_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_acting_staff_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_acting_staff_session_user_id_user_id_fk" FOREIGN KEY ("session_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_acting_staff_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_acting_staff_device_fk" FOREIGN KEY ("tenant_id","outlet_id","device_id") REFERENCES "public"."devices"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_acting_staff_live_device_key" ON "pos_acting_staff" USING btree ("tenant_id","device_id") WHERE "pos_acting_staff"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pos_acting_staff_live_staff_idx" ON "pos_acting_staff" USING btree ("tenant_id","outlet_id","staff_user_id") WHERE "pos_acting_staff"."revoked_at" IS NULL;
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_acting_staff'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_acting_staff'::regclass);
--> statement-breakpoint
-- Tokens are revoked, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE public.pos_acting_staff FROM legend_app;
