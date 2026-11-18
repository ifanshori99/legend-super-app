-- 936 (legend-hpgyw part D): facility tickets sold at the POS. The line ties one
-- access ticket to the order line that pays for it (issued only when the bill
-- is paid, refunded with the line); the credential table keeps digests only.
-- Foreign keys are inline (docs/plan/contracts.md "Migrations: foreign keys
-- into FORCE RLS tables", pattern 1).
CREATE TABLE "facility_ticket_pos_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"access_ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"line_total_idr" bigint NOT NULL,
	"issued_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_ticket_pos_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "facility_ticket_pos_lines_ticket_key" UNIQUE("tenant_id","access_ticket_id"),
	CONSTRAINT "facility_ticket_pos_lines_item_key" UNIQUE("tenant_id","order_item_id"),
	CONSTRAINT "facility_ticket_pos_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_facility_fk" FOREIGN KEY ("tenant_id","outlet_id","facility_id") REFERENCES "public"."facilities"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_item_fk" FOREIGN KEY ("tenant_id","order_item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "facility_ticket_pos_lines_status_check" CHECK ("facility_ticket_pos_lines"."status" IN ('pending', 'issued', 'cancelled', 'refunded')),
	CONSTRAINT "facility_ticket_pos_lines_amount_check" CHECK ("facility_ticket_pos_lines"."line_total_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "access_ticket_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"access_ticket_id" uuid NOT NULL,
	"qr_digest" varchar(64) NOT NULL,
	"pin_digest" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"minted_key" varchar(120) NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_ticket_credentials_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "access_ticket_credentials_ticket_key" UNIQUE("tenant_id","access_ticket_id"),
	CONSTRAINT "access_ticket_credentials_qr_key" UNIQUE("tenant_id","qr_digest"),
	CONSTRAINT "access_ticket_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credentials_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credentials_ticket_fk" FOREIGN KEY ("tenant_id","access_ticket_id") REFERENCES "public"."access_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "access_ticket_credentials_window_check" CHECK ("access_ticket_credentials"."valid_until" > "access_ticket_credentials"."valid_from" AND "access_ticket_credentials"."version" >= 1)
);
--> statement-breakpoint
-- Custom SQL (mirrors src/db/schema/facility.custom.sql): tenant + outlet RLS.
SELECT app.enforce_tenant_rls('public.facility_ticket_pos_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.facility_ticket_pos_lines'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.access_ticket_credentials'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.access_ticket_credentials'::regclass);
