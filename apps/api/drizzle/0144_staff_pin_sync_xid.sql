-- legend-t9ii: commit-ordered sync version of a staff pin. The cloud -> edge
-- export used to page by (updated_at, id) behind a 5 s settle window, which
-- trusts a clock and a commit delay. sync_xid is the id of the transaction that
-- last wrote the row; the export reads only rows below the oldest transaction
-- still open (pg_snapshot_xmin), so a writer that commits late is never passed
-- by an already advanced watermark.
-- The default stamps an insert (and every existing row, once, with this
-- migration's transaction: the edge then does one idempotent full resync); the
-- trigger stamps every update, so no application code can forget it.
ALTER TABLE "staff_pins" ADD COLUMN "sync_xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE INDEX "staff_pins_sync_idx" ON "staff_pins" USING btree ("tenant_id","outlet_id","sync_xid","id");--> statement-breakpoint
CREATE FUNCTION app.stamp_staff_pin_sync_xid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.sync_xid := pg_current_xact_id();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER staff_pins_sync_xid BEFORE UPDATE ON public.staff_pins
  FOR EACH ROW EXECUTE FUNCTION app.stamp_staff_pin_sync_xid();
