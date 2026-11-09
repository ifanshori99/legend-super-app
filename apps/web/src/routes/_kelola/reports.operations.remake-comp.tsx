import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/operations/remake-comp — generic report viewer for operations.remake_comp (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/operations/remake-comp")(
  reportRouteOptions("operations.remake_comp"),
);
