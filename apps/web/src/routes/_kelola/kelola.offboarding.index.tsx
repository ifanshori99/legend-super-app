import { createFileRoute } from "@tanstack/react-router";
import { OffboardingPage } from "@/features/ws10-lifecycle/components/offboarding-page";
import { lifecycleGuard } from "@/features/ws10-lifecycle/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws10-lifecycle/lib";
import {
  employeesQuery,
  positionsQuery,
} from "@/features/ws10-lifecycle/queries";

// /kelola/offboarding — employees resigning or terminated with their exit
// clearance (PRD v1.7 §3 D26 "Offboarding").
export const Route = createFileRoute("/_kelola/kelola/offboarding/")({
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
  component: OffboardingScreen,
});

function OffboardingScreen() {
  return <OffboardingPage />;
}
