import { createFileRoute } from "@tanstack/react-router";
import { SelfieReviewPage } from "@/features/ws10-attendance-qr/components/selfie-review-page";
import { attendanceGuard } from "@/features/ws10-attendance-qr/guard";

// /kelola/absensi/selfie — supervisor selfie sampling review (PRD v1.7 §3 F25,
// bead legend-0z5k). "Today" is the outlet's business date from the device
// clock, so the page reads in the browser instead of a route loader.
export const Route = createFileRoute("/_kelola/kelola/absensi/selfie")({
  beforeLoad: attendanceGuard(["hr.attendance.manage"]),
  component: SelfieReviewPage,
});
