import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/revpash — generic report viewer for facility.revpash
// (PRD v1.7 §3 "Pengukuran WFC": RevPASH per zona dan per jam).
export const Route = createFileRoute("/_kelola/reports/facility/revpash")(
  reportRouteOptions("facility.revpash"),
);
