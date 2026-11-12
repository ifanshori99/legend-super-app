import { createFileRoute } from "@tanstack/react-router";
import { ChargeScreen } from "@/features/ws04-pos-order-detail/components/charge-screen";
import { chargeCollectGuard } from "@/features/ws04-pos-order-detail/guard";

// /pos/tagih-selisih/$chargeId — the cashier takes the price difference of a
// dearer menu swap in cash. The `?demo=` seed is read by the mock module only.
export const Route = createFileRoute("/_ops/pos/tagih-selisih/$chargeId")({
  beforeLoad: chargeCollectGuard(),
  component: ChargeRoute,
});

function ChargeRoute() {
  const { chargeId } = Route.useParams();
  return <ChargeScreen chargeId={chargeId} />;
}
