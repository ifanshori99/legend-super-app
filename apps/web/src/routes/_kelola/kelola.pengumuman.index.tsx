import { createFileRoute } from "@tanstack/react-router";
import { AnnouncementsPage } from "@/features/ws10-learning/components/announcements-page";
import { learningGuard } from "@/features/ws10-learning/guard";
import { isMockScenarioRequest } from "@/features/ws10-learning/lib";
import {
  announcementsQuery,
  employeesQuery,
  myProfileQuery,
} from "@/features/ws10-learning/queries";

// /kelola/pengumuman — internal announcements with read receipts (PRD v1.7
// §3 F32 "Pengumuman Internal", F29 "tanda terima").
export const Route = createFileRoute("/_kelola/kelola/pengumuman/")({
  beforeLoad: learningGuard(["hr.sop.manage"]),
  loader: ({ context, location }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(announcementsQuery()),
      context.queryClient.ensureQueryData(employeesQuery()),
      context.queryClient.ensureQueryData(myProfileQuery()),
    ]);
  },
  component: AnnouncementsScreen,
});

function AnnouncementsScreen() {
  return <AnnouncementsPage />;
}
