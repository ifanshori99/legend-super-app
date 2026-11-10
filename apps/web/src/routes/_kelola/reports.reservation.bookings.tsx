import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/reservation/bookings — generic report viewer for reservation.bookings (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/reservation/bookings")(
  reportRouteOptions("reservation.bookings"),
);
