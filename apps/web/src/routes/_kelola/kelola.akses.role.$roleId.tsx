import { createFileRoute } from "@tanstack/react-router";
import { RoleDetailPage } from "@/features/ws01-access/components/role-editor-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { accessViewerUserId } from "@/features/ws01-access/viewer";
import { isMockScenarioRequest } from "@/features/ws01-access/lib";
import { rolesQuery } from "@/features/ws01-access/queries";

// /kelola/akses/role/<roleId> — one role: read-only template or editor.
export const Route = createFileRoute("/_kelola/kelola/akses/role/$roleId")({
  beforeLoad: accessGuard(["access.role.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(rolesQuery()),
  component: RoleScreen,
});

function RoleScreen() {
  const { access, session } = Route.useRouteContext();
  const { roleId } = Route.useParams();
  return (
    <RoleDetailPage
      roleId={roleId}
      access={access}
      viewerUserId={accessViewerUserId(session)}
    />
  );
}
