import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/reservation/peak-hours — generic report viewer for reservation.peak_hours (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/reservation/peak-hours")(
  reportRouteOptions("reservation.peak_hours"),
);
