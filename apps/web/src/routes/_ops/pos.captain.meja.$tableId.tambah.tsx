import { createFileRoute } from "@tanstack/react-router";
import { AddOrderScreen } from "@/features/ws04-pos-order/components/captain/add-order-screen";
import { captainOrderGuard } from "@/features/ws04-pos-order/components/captain/captain-order-guard";

// /pos/captain/meja/$tableId/tambah — pick menu items for the table.
export const Route = createFileRoute("/_ops/pos/captain/meja/$tableId/tambah")({
  beforeLoad: captainOrderGuard(),
  component: AddOrderRoute,
});

function AddOrderRoute() {
  const { tableId } = Route.useParams();
  return <AddOrderScreen tableId={tableId} />;
}
