import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/subscriptions — generic report viewer for
// facility.subscriptions (PRD v1.7 §3 F25 "Laporan": pemakaian kuota
// langganan dan benefit tier).
export const Route = createFileRoute("/_kelola/reports/facility/subscriptions")(
  reportRouteOptions("facility.subscriptions"),
);
