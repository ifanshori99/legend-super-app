import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AreaFrame } from "@/components/layout/area-frame";
import { kelolaGuardForPath } from "@/lib/areas/kelola-guard";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "kelola" (PRD §5). Guard and shell come from lib/areas/definitions.ts;
// the aggregate reports a shareholder tile links to also accept
// report.aggregate.view (lib/areas/kelola-guard.ts, legend-5bjh).
export const Route = createFileRoute("/_kelola")({
  beforeLoad: ({ context, location }) =>
    runGuard(kelolaGuardForPath(location.pathname), context.access),
  head: () => areaHead("kelola"),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="kelola" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
