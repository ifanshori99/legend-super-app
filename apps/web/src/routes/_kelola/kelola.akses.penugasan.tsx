import { createFileRoute } from "@tanstack/react-router";
import { AssignmentsPage } from "@/features/ws01-access/components/assignments-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { useViewerUserId } from "@/features/ws01-access/hooks";
import { isMockScenarioRequest } from "@/features/ws01-access/lib";
import { assignablePeopleQuery } from "@/features/ws01-access/people";
import { assignmentsQuery, rolesQuery } from "@/features/ws01-access/queries";

// /kelola/akses/penugasan — scoped, time-bound role assignments (TEN-03).
export const Route = createFileRoute("/_kelola/kelola/akses/penugasan")({
  beforeLoad: accessGuard(["access.role.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(rolesQuery()),
          context.queryClient.ensureQueryData(assignmentsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(assignablePeopleQuery()),
        ]),
  component: AssignmentsScreen,
});

function AssignmentsScreen() {
  const { access, session } = Route.useRouteContext();
  const viewerUserId = useViewerUserId(session?.user.id);
  return <AssignmentsPage access={access} viewerUserId={viewerUserId} />;
}
