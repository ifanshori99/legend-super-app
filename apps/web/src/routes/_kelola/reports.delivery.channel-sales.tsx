import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/delivery/channel-sales — generic report viewer for delivery.channel_sales (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/delivery/channel-sales")(
  reportRouteOptions("delivery.channel_sales"),
);
