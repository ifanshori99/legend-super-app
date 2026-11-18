import { createFileRoute, Outlet } from "@tanstack/react-router";
import { withI18nChunks } from "@/components/i18n";
import { AreaFrame } from "@/components/layout/area-frame";
import { AREAS } from "@/lib/areas/definitions";
import { areaHead, runGuard } from "@/lib/areas/route";

// Area "kitchen" (PRD §5). Guard and shell come from lib/areas/definitions.ts.
export const Route = createFileRoute("/_kitchen")({
  beforeLoad: ({ context }) =>
    withI18nChunks(["kitchen"], runGuard(AREAS.kitchen.guard, context.access)),
  head: () => areaHead("kitchen"),
  component: Layout,
});

function Layout() {
  const { access, session, gate } = Route.useRouteContext();
  return (
    <AreaFrame area="kitchen" access={access} gate={gate} session={session}>
      <Outlet />
    </AreaFrame>
  );
}
