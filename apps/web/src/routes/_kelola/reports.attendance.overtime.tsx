import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/attendance/overtime — generic report viewer for attendance.overtime (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/attendance/overtime")(
  reportRouteOptions("attendance.overtime"),
);
