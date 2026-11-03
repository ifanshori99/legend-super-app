import { createFileRoute } from "@tanstack/react-router";
import { OnboardingPage } from "@/features/ws10-lifecycle/components/onboarding-page";
import { lifecycleGuard } from "@/features/ws10-lifecycle/guard";
import { isMockScenarioRequest } from "@/features/ws10-lifecycle/lib";
import { LIST_LIMIT } from "@/features/ws10-lifecycle/lib";
import {
  employeesQuery,
  positionsQuery,
} from "@/features/ws10-lifecycle/queries";

// /kelola/onboarding — employees being onboarded (PRD v1.7 §3 D26
// "Onboarding", §4 Alur M).
export const Route = createFileRoute("/_kelola/kelola/onboarding/")({
  beforeLoad: lifecycleGuard(["hr.employee.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            employeesQuery({ limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(positionsQuery()),
        ]),
  component: OnboardingScreen,
});

function OnboardingScreen() {
  return <OnboardingPage />;
}
