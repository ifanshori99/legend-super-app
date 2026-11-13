CREATE TABLE "kirimdev_sender_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"phone_number_id" text NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kirimdev_sender_mappings_phone_number_check" CHECK ("kirimdev_sender_mappings"."phone_number_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "kirimdev_sender_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "kirimdev_sender_mappings_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "kirimdev_sender_mappings_phone_number_key" ON "kirimdev_sender_mappings" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kirimdev_sender_mappings_tenant_key" ON "kirimdev_sender_mappings" USING btree ("tenant_id") WHERE "kirimdev_sender_mappings"."outlet_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kirimdev_sender_mappings_outlet_key" ON "kirimdev_sender_mappings" USING btree ("tenant_id","outlet_id") WHERE "kirimdev_sender_mappings"."outlet_id" IS NOT NULL;
--> statement-breakpoint
-- legend-nqxtb: platform-managed Kirimdev sender mapping. Tenant RLS (TEN-01/02):
-- a tenant context sees only its own row. Only a platform admin route writes it
-- (no tenant endpoint exists); the platform acts on the target tenant through
-- withTenant, like the other platform services that touch tenant tables.
SELECT app.enforce_tenant_rls('public.kirimdev_sender_mappings'::regclass);
--> statement-breakpoint
-- Write guard: the table changes only inside the platform sender-mapping
-- service transactions, which set the transaction-local flag
-- app.kirimdev_sender_write = 'on'. The message carries no row data.
CREATE OR REPLACE FUNCTION app.kirimdev_sender_mappings_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.kirimdev_sender_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'kirimdev_sender_mappings can only be changed by the platform sender mapping service'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER kirimdev_sender_mappings_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.kirimdev_sender_mappings
  FOR EACH ROW EXECUTE FUNCTION app.kirimdev_sender_mappings_write_guard();
