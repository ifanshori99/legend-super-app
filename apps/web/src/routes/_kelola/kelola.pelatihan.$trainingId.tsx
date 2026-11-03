import { createFileRoute } from "@tanstack/react-router";
import { TrainingDetailPage } from "@/features/ws10-learning/components/training-detail-page";
import { learningGuard } from "@/features/ws10-learning/guard";
import { isMockScenarioRequest } from "@/features/ws10-learning/lib";
import {
  myProfileQuery,
  positionsQuery,
  trainingsQuery,
} from "@/features/ws10-learning/queries";

// /kelola/pelatihan/$trainingId — one module's material and graded quiz (PRD
// v1.7 §3 F32 "Pelatihan", F29 certification).
export const Route = createFileRoute("/_kelola/kelola/pelatihan/$trainingId")({
  beforeLoad: learningGuard(["hr.training.manage"]),
  loader: ({ context, location }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(trainingsQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(myProfileQuery()),
    ]);
  },
  component: TrainingDetailScreen,
});

function TrainingDetailScreen() {
  const { trainingId } = Route.useParams();
  return <TrainingDetailPage trainingId={trainingId} />;
}
