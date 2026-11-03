import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/wifi — generic report viewer for facility.wifi
// (PRD v1.7 §3 "Wi-Fi Tamu": kuota dan sesi tamu).
export const Route = createFileRoute("/_kelola/reports/facility/wifi")(
  reportRouteOptions("facility.wifi"),
);
