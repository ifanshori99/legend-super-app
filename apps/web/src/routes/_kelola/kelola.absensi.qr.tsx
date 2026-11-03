import { createFileRoute } from "@tanstack/react-router";
import { QrDisplayPage } from "@/features/ws10-attendance-qr/components/qr-display-page";
import { attendanceGuard } from "@/features/ws10-attendance-qr/guard";

// /kelola/absensi/qr — outlet wall display of the rotating attendance QR
// (PRD v1.7 §3 F27/F25, bead legend-0z5k). The token is live, so the page
// fetches it in the browser instead of a route loader.
export const Route = createFileRoute("/_kelola/kelola/absensi/qr")({
  beforeLoad: attendanceGuard(["hr.attendance.manage"]),
  component: QrDisplayPage,
});
