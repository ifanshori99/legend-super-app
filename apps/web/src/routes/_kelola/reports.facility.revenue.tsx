import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/revenue — generic report viewer for facility.revenue
// (PRD v1.7 §3 F25 "Laporan": pendapatan per fasilitas).
export const Route = createFileRoute("/_kelola/reports/facility/revenue")(
  reportRouteOptions("facility.revenue"),
);
