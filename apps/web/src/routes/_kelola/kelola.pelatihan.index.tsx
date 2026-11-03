import { createFileRoute } from "@tanstack/react-router";
import { TrainingPage } from "@/features/ws10-learning/components/training-page";
import { learningGuard } from "@/features/ws10-learning/guard";
import { isMockScenarioRequest } from "@/features/ws10-learning/lib";
import {
  myProfileQuery,
  positionsQuery,
  trainingsQuery,
} from "@/features/ws10-learning/queries";

// /kelola/pelatihan — training modules, quiz results and certification
// (PRD v1.7 §3 F32 "Pelatihan").
export const Route = createFileRoute("/_kelola/kelola/pelatihan/")({
  beforeLoad: learningGuard(["hr.training.manage"]),
  loader: ({ context, location }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(trainingsQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(myProfileQuery()),
    ]);
  },
  component: TrainingScreen,
});

function TrainingScreen() {
  return <TrainingPage />;
}
