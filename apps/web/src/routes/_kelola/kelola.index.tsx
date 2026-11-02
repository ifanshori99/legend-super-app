import { createFileRoute } from "@tanstack/react-router";
import { z } from "@starter/shared/core";
import { managementRoleSchema } from "@starter/shared/dashboard";
import { ManagementHomePage } from "@/features/ws11-management-home/components/management-home-page";
import {
  defaultRole,
  isMockScenarioRequest,
  kpiRunInput,
  roleKpiTile,
  rolesInLayout,
} from "@/features/ws11-management-home/lib";
import {
  kpiRunQuery,
  managementLayoutQuery,
} from "@/features/ws11-management-home/queries";

// /kelola — management home per role (PRD v1.7 §3.36 "Beranda per Role",
// legend-6na6; DESIGN.md v3 dashboard pattern). The role is a preview lens kept
// in the URL (`?role=finance`) so a link shows the same home to the same
// person. The API composes the caller's own tiles; a role the payload does not
// contain falls back to the first role it offers.
export const Route = createFileRoute("/_kelola/kelola/")({
  validateSearch: z.object({
    role: managementRoleSchema.optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ role: search.role }),
  loader: async ({ context, location, deps }) => {
    // `?mock=empty|slow|…` must reach the browser, not be frozen into the SSR
    // HTML (docs/frontend.md "See loading, empty and error states").
    if (isMockScenarioRequest(location.searchStr)) return;
    const layout = await context.queryClient.ensureQueryData(
      managementLayoutQuery({}),
    );
    const roles = rolesInLayout(layout.tiles);
    const role =
      deps.role && roles.includes(deps.role)
        ? deps.role
        : defaultRole(layout.tiles);
    const tile = role === null ? null : roleKpiTile(layout.tiles, role);
    // The strip's numbers are a second request; prefetch so SSR paints them,
    // and never fail the page when a report is unavailable (the strip says
    // "no data" instead).
    if (tile !== null)
      await context.queryClient.prefetchQuery(
        kpiRunQuery(kpiRunInput(tile, layout)),
      );
  },
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
