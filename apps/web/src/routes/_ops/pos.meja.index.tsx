import { createFileRoute } from "@tanstack/react-router";
import { FloorBoardPage } from "@/features/ws03-floor/components/floor-board";
import { floorPageGuard } from "@/features/ws03-floor/guard";
import { holdsAny } from "@/lib/areas/guard";

// /pos/meja — live table status board and table operations (PRD §3 "9. Denah &
// Meja": Papan Status, Operasi Meja; ORD-10).
export const Route = createFileRoute("/_ops/pos/meja/")({
  beforeLoad: floorPageGuard(),
  component: FloorBoardScreen,
});

function FloorBoardScreen() {
  const { access } = Route.useRouteContext();
  return (
    <FloorBoardPage canManage={holdsAny(access, ["floor.table.manage"])} />
  );
}
