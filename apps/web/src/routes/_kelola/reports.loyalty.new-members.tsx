import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/loyalty/new-members — generic report viewer for loyalty.new_members (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/loyalty/new-members")(
  reportRouteOptions("loyalty.new_members"),
);
