import { createFileRoute } from "@tanstack/react-router";
import { captainOrderGuard } from "@/features/ws04-pos-order/components/captain/captain-order-guard";
import { TableOrderScreen } from "@/features/ws04-pos-order/components/captain/table-order-screen";

// /pos/captain/meja/$tableId — a table's order: sent and held items.
export const Route = createFileRoute("/_ops/pos/captain/meja/$tableId/")({
  beforeLoad: captainOrderGuard(),
  component: TableOrderRoute,
});

function TableOrderRoute() {
  const { tableId } = Route.useParams();
  return <TableOrderScreen tableId={tableId} />;
}
