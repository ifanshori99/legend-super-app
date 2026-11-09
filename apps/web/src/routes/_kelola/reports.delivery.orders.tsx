import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/delivery/orders — generic report viewer for delivery.orders (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/delivery/orders")(
  reportRouteOptions("delivery.orders"),
);
