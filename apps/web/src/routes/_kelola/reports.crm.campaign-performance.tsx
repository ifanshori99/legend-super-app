import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/crm/campaign-performance — generic report viewer for crm.campaign_performance (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/crm/campaign-performance",
)(reportRouteOptions("crm.campaign_performance"));
