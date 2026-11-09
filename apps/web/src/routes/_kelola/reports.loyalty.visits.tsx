import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/loyalty/visits — generic report viewer for loyalty.visits (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/loyalty/visits")(
  reportRouteOptions("loyalty.visits"),
);
