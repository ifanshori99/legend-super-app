ALTER TABLE "session" DROP CONSTRAINT "session_auth_method_check";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "edge_device_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
CREATE INDEX "session_edge_device_id_idx" ON "session" USING btree ("edge_device_id") WHERE "session"."edge_device_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_edge_staff_pin_check" CHECK (("session"."auth_method" = 'edge_staff_pin') = ("session"."edge_device_id" IS NOT NULL) AND ("session"."auth_method" <> 'edge_staff_pin' OR ("session"."kind" = 'customer' AND "session"."mfa_verified_at" IS NULL AND "session"."mfa_challenge_verified_at" IS NULL AND "session"."impersonated_by" IS NULL)));--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_auth_method_check" CHECK ("session"."auth_method" IN ('password', 'whatsapp', 'email_magic_link', 'google', 'legacy', 'edge_staff_pin'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_token_hash_check" CHECK ("devices"."token_hash" IS NULL OR "devices"."token_hash" ~ '^[0-9a-f]{64}$');