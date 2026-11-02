import { createFileRoute } from "@tanstack/react-router";
import { z } from "@starter/shared/core";
import { managementRoleSchema } from "@starter/shared/dashboard";
import { ManagementHomePage } from "@/features/ws11-management-home/components/management-home-page";
import { isMockScenarioRequest } from "@/features/ws11-management-home/lib";
import { managementLayoutQuery } from "@/features/ws11-management-home/queries";

// /kelola — management home per role (PRD v1.7 §3.36 "Beranda per Role").
// The role is a preview lens kept in the URL (`?role=finance`) so a link shows
// the same home to the same person. The API composes the caller's own tiles;
// a role the payload does not contain falls back to the first role it offers.
export const Route = createFileRoute("/_kelola/kelola/")({
  validateSearch: z.object({
    role: managementRoleSchema.optional().catch(undefined),
  }),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(managementLayoutQuery({})),
  component: ManagementHomeScreen,
});

function ManagementHomeScreen() {
  const { access } = Route.useRouteContext();
  const { role } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ManagementHomePage
      access={access}
      role={role ?? null}
      onRoleChange={(next) => {
        void navigate({
          search: (previous) => ({ ...previous, role: next }),
        });
      }}
    />
  );
}
