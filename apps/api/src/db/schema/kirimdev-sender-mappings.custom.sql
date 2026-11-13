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
