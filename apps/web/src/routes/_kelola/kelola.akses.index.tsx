import { createFileRoute } from "@tanstack/react-router";
import { RoleListPage } from "@/features/ws01-access/components/role-list-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { isMockScenarioRequest } from "@/features/ws01-access/lib";
import { assignmentsQuery, rolesQuery } from "@/features/ws01-access/queries";

// /kelola/akses — roles (PRD §3 F7 Template Role + Custom Role).
export const Route = createFileRoute("/_kelola/kelola/akses/")({
  beforeLoad: accessGuard(["access.role.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(rolesQuery()),
          context.queryClient.ensureQueryData(assignmentsQuery({ limit: 100 })),
        ]),
  component: RolesScreen,
});

function RolesScreen() {
  const { access } = Route.useRouteContext();
  return <RoleListPage access={access} />;
}
