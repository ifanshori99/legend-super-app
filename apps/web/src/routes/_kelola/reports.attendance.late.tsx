import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/attendance/late — generic report viewer for attendance.late (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/attendance/late")(
  reportRouteOptions("attendance.late"),
);
