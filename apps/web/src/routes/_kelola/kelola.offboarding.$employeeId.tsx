import { createFileRoute } from "@tanstack/react-router";
import { OffboardingDetailPage } from "@/features/ws10-lifecycle/components/offboarding-detail-page";
import { lifecycleGuard } from "@/features/ws10-lifecycle/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws10-lifecycle/lib";
import {
  checklistTasksQuery,
  employeeQuery,
  employeesQuery,
  orgUnitsQuery,
  positionsQuery,
} from "@/features/ws10-lifecycle/queries";

// /kelola/offboarding/$employeeId — exit clearance, final settlement summary
// and the work certificate preview (PRD v1.7 §3 D26 "Offboarding").
export const Route = createFileRoute("/_kelola/kelola/offboarding/$employeeId")(
  {
    beforeLoad: lifecycleGuard(["hr.employee.manage"]),
    loader: ({ context, location, params }) => {
      if (isMockScenarioRequest(location.searchStr)) return undefined;
      return Promise.all([
        context.queryClient.ensureQueryData(employeeQuery(params.employeeId)),
        context.queryClient.ensureQueryData(positionsQuery()),
        context.queryClient.ensureQueryData(orgUnitsQuery()),
        // The directory resolves the manager named on the certificate.
        context.queryClient.ensureQueryData(
          employeesQuery({ limit: LIST_LIMIT }),
        ),
        context.queryClient.ensureQueryData(
          checklistTasksQuery(params.employeeId, "offboarding"),
        ),
      ]);
    },
    component: OffboardingDetailScreen,
  },
);

function OffboardingDetailScreen() {
  const { employeeId } = Route.useParams();
  return <OffboardingDetailPage employeeId={employeeId} />;
}
