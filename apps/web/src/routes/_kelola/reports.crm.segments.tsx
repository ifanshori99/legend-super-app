import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/crm/segments — generic report viewer for crm.segments (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/crm/segments")(
  reportRouteOptions("crm.segments"),
);
