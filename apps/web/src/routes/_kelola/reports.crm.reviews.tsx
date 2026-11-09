import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/crm/reviews — generic report viewer for crm.reviews (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/crm/reviews")(
  reportRouteOptions("crm.reviews"),
);
