import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/purchasing/receipts — generic report viewer for purchasing.receipts (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/purchasing/receipts")(
  reportRouteOptions("purchasing.receipts"),
);
