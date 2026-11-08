import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/purchasing/requests — generic report viewer for purchasing.requests (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/purchasing/requests")(
  reportRouteOptions("purchasing.requests"),
);
