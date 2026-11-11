-- Hand SQL for wfc_seats, wfc_seat_reservations and wfc_day_pass_purchases
-- (bead legend-bz9h; PRD v1.7 §3 F25/F39, FAC-14). To be appended to the
-- generated `wfc_products` migration by the lead.

-- M5: a seat cannot be double-booked. Only holds that still occupy the seat
-- count; cancelled / no_show / refunded / completed drop out.
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
SELECT app.enforce_tenant_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_seat_reservations'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.wfc_day_pass_purchases'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.wfc_day_pass_purchases'::regclass);
