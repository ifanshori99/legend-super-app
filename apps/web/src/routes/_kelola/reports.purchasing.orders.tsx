import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/purchasing/orders — generic report viewer for purchasing.orders (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/purchasing/orders")(
  reportRouteOptions("purchasing.orders"),
);
