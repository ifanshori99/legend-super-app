import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/crm/repeat-visit — generic report viewer for crm.repeat_visit (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/crm/repeat-visit")(
  reportRouteOptions("crm.repeat_visit"),
);
