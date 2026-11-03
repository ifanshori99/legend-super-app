import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/facility/fnb-conversion — generic report viewer for
// facility.fnb_conversion (PRD v1.7 §3 F25 "Laporan": konversi pengguna shower
// ke pembelian F&B).
export const Route = createFileRoute(
  "/_kelola/reports/facility/fnb-conversion",
)(reportRouteOptions("facility.fnb_conversion"));
