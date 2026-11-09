import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/menu/engineering — generic report viewer for menu.engineering (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/menu/engineering")(
  reportRouteOptions("menu.engineering"),
);
