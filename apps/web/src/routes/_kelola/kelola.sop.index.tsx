import { createFileRoute } from "@tanstack/react-router";
import { SopPage } from "@/features/ws10-learning/components/sop-page";
import { learningGuard } from "@/features/ws10-learning/guard";
import { isMockScenarioRequest } from "@/features/ws10-learning/lib";
import {
  myProfileQuery,
  positionsQuery,
  sopDocumentsQuery,
} from "@/features/ws10-learning/queries";

// /kelola/sop — the versioned SOP library with read confirmation (PRD v1.7
// §3 F32 "Pustaka SOP", F29).
export const Route = createFileRoute("/_kelola/kelola/sop/")({
  beforeLoad: learningGuard(["hr.sop.manage"]),
  loader: ({ context, location }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(sopDocumentsQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(myProfileQuery()),
    ]);
  },
  component: SopScreen,
});

function SopScreen() {
  return <SopPage />;
}
