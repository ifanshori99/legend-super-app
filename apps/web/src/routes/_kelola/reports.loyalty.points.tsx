import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/loyalty/points — generic report viewer for loyalty.points (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/loyalty/points")(
  reportRouteOptions("loyalty.points"),
);
