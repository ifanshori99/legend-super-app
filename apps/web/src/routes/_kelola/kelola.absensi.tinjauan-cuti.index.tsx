import { createFileRoute } from "@tanstack/react-router";
import { LeaveClockinQueuePage } from "@/features/hr-leave-clockin-review/components/leave-clockin-queue-page";
import { attendanceGuard } from "@/features/ws10-attendance-qr/guard";

// /kelola/absensi/tinjauan-cuti — HR queue of attendance logged on an approved
// leave day (bead legend-3jem1). Reads in the browser (outlet from the shell),
// like the selfie review, so there is no route loader.
export const Route = createFileRoute("/_kelola/kelola/absensi/tinjauan-cuti/")({
  beforeLoad: attendanceGuard(["hr.attendance.manage"]),
  component: LeaveClockinQueuePage,
});
