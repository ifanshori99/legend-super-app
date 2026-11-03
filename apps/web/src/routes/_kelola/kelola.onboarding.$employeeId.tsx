import { createFileRoute } from "@tanstack/react-router";
import { OnboardingDetailPage } from "@/features/ws10-lifecycle/components/onboarding-detail-page";
import { lifecycleGuard } from "@/features/ws10-lifecycle/guard";
import { isMockScenarioRequest } from "@/features/ws10-lifecycle/lib";
import {
  checklistTasksQuery,
  employeeQuery,
  orgUnitsQuery,
  positionsQuery,
} from "@/features/ws10-lifecycle/queries";

// /kelola/onboarding/$employeeId — one employee's onboarding checklist
// (PRD v1.7 §3 D26 "Onboarding").
export const Route = createFileRoute("/_kelola/kelola/onboarding/$employeeId")({
  beforeLoad: lifecycleGuard(["hr.employee.manage"]),
  loader: ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(employeeQuery(params.employeeId)),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(orgUnitsQuery()),
      context.queryClient.ensureQueryData(
        checklistTasksQuery(params.employeeId, "onboarding"),
      ),
    ]);
  },
  component: OnboardingDetailScreen,
});

function OnboardingDetailScreen() {
  const { employeeId } = Route.useParams();
  return <OnboardingDetailPage employeeId={employeeId} />;
}
