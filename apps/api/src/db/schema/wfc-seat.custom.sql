-- Hand SQL of the paid WFC tables (brief 1270 W1, migration 0526; PRD v1.7 §3
-- F25/F39, FAC-14). btree_gist comes from 0044.
--
-- A seat cannot be double-booked. Only claims that still occupy the seat count;
-- cancelled / no_show / refunded / completed drop out. The list is
-- WFC_ACTIVE_RESERVATION_STATUSES of @starter/shared/wfc.
ALTER TABLE "wfc_seat_reservations"
  ADD CONSTRAINT "wfc_seat_reservations_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "seat_id" WITH =,
    "slot" WITH &&
  ) WHERE (status IN ('pending_payment','confirmed','checked_in'));
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seats'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_hourly_quotas'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_business_settings'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
-- enforce_tenant_rls hands legend_app full DML: a settings version is
-- append-only and a claim or seat (the base of a claim) is never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.wfc_business_settings FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seat_reservations FROM legend_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.wfc_seats FROM legend_app;
--> statement-breakpoint
CREATE TRIGGER "wfc_business_settings_append_only_trg"
  BEFORE UPDATE OR DELETE ON "wfc_business_settings"
  FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
