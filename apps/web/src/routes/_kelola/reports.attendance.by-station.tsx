import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/attendance/by-station — generic report viewer for attendance.by_station (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/attendance/by-station")(
  reportRouteOptions("attendance.by_station"),
);
