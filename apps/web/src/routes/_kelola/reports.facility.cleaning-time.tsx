import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/cleaning-time — generic report viewer for facility.cleaning_time
// (PRD v1.7 §3 F25 "Laporan": waktu pembersihan).
export const Route = createFileRoute("/_kelola/reports/facility/cleaning-time")(
  reportRouteOptions("facility.cleaning_time"),
);
