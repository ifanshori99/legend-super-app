import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/product-revenue — generic report viewer for facility.product_revenue
// (PRD v1.7 §3 F25 "Laporan": pendapatan per produk).
export const Route = createFileRoute(
  "/_kelola/reports/facility/product-revenue",
)(reportRouteOptions("facility.product_revenue"));
