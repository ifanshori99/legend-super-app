import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/reservation/no-show — generic report viewer for reservation.no_show (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/reservation/no-show")(
  reportRouteOptions("reservation.no_show"),
);
