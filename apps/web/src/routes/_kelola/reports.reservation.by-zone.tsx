import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/reservation/by-zone — generic report viewer for reservation.by_zone (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/reservation/by-zone")(
  reportRouteOptions("reservation.by_zone"),
);
