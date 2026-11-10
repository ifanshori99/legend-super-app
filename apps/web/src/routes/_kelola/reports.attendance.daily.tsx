import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/attendance/daily — generic report viewer for attendance.daily (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/attendance/daily")(
  reportRouteOptions("attendance.daily"),
);
