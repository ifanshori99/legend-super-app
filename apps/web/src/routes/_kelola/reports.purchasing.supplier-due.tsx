import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/purchasing/supplier-due — generic report viewer for purchasing.supplier_due (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/purchasing/supplier-due",
)(reportRouteOptions("purchasing.supplier_due"));
