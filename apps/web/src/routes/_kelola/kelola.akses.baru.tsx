import { createFileRoute } from "@tanstack/react-router";
import { CreateCustomRolePage } from "@/features/ws01-access/components/role-editor-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { accessViewerUserId } from "@/features/ws01-access/viewer";

// /kelola/akses/baru — custom role builder (PRD §3 F7 "Custom Role").
export const Route = createFileRoute("/_kelola/kelola/akses/baru")({
  beforeLoad: accessGuard(["access.role.manage"]),
  component: NewRoleScreen,
});

function NewRoleScreen() {
  const { access, session } = Route.useRouteContext();
  return (
    <CreateCustomRolePage
      access={access}
      viewerUserId={accessViewerUserId(session)}
    />
  );
}
