import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/purchasing/price-history — generic report viewer for purchasing.price_history (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/purchasing/price-history",
)(reportRouteOptions("purchasing.price_history"));
