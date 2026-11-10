import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/unit-utilization — generic report viewer for facility.unit_utilization
// (PRD v1.7 §3 "Pengukuran WFC": utilisasi unit per jam).
export const Route = createFileRoute(
  "/_kelola/reports/facility/unit-utilization",
)(reportRouteOptions("facility.unit_utilization"));
