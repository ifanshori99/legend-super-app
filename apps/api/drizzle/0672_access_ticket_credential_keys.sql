-- 936 second-opinion fix (legend-hpgyw, group T): the credential table keeps
-- only the newest mint key, so an older key replayed after a newer mint looked
-- fresh and rotated the newest QR/PIN pair. This table keeps a digest of every
-- key ever used for a ticket; the mint refuses a key found here. Foreign keys
-- are inline (docs/plan/contracts.md "Migrations: foreign keys into FORCE RLS
-- tables", pattern 1); RLS as in 0671.
CREATE TABLE "access_ticket_credential_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"access_ticket_id" uuid NOT NULL,
	"key_digest" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_ticket_credential_keys_key" UNIQUE("tenant_id","access_ticket_id","key_digest"),
	CONSTRAINT "access_ticket_credential_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credential_keys_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credential_keys_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credential_keys_version_check" CHECK ("access_ticket_credential_keys"."version" >= 1)
);
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/facility.custom.sql): tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.access_ticket_credential_keys'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.access_ticket_credential_keys'::regclass);
