import { createFileRoute, Outlet } from "@tanstack/react-router";
import { withI18nChunks } from "@/components/i18n";
import { AreaFrame } from "@/components/layout/area-frame";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "owner" (PRD §5). Guard and shell come from lib/areas/definitions.ts.
export const Route = createFileRoute("/_owner")({
  beforeLoad: ({ context }) =>
    withI18nChunks(["owner"], runGuard(AREAS.owner.guard, context.access)),
  head: () => areaHead("owner"),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="owner" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
