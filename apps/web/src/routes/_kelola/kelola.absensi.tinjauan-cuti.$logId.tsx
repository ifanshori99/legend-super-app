import { createFileRoute } from "@tanstack/react-router";
import { LeaveClockinDetailPage } from "@/features/hr-leave-clockin-review/components/leave-clockin-detail-page";
import { attendanceGuard } from "@/features/ws10-attendance-qr/guard";

// /kelola/absensi/tinjauan-cuti/$logId — HR decision on one clock-in made on an
// approved leave day (bead legend-3jem1). Reads in the browser: the case is
// enriched from several outlet endpoints, so no route loader.
export const Route = createFileRoute(
  "/_kelola/kelola/absensi/tinjauan-cuti/$logId",
)({
  beforeLoad: attendanceGuard(["hr.attendance.manage"]),
  component: LeaveClockinDetailRoute,
});

function LeaveClockinDetailRoute() {
  const { logId } = Route.useParams();
  return <LeaveClockinDetailPage logId={logId} />;
}
