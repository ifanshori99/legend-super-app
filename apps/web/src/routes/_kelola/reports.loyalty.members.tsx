import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/loyalty/members — generic report viewer for loyalty.members (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/loyalty/members")(
  reportRouteOptions("loyalty.members"),
);
