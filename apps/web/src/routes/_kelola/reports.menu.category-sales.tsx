import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/category-sales — generic report viewer for menu.category_sales (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/category-sales")(
  reportRouteOptions("menu.category_sales"),
);
