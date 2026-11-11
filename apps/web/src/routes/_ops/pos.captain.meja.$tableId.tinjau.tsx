import { createFileRoute } from "@tanstack/react-router";
import { captainOrderGuard } from "@/features/ws04-pos-order/components/captain/captain-order-guard";
import { ReviewScreen } from "@/features/ws04-pos-order/components/captain/review-screen";

// /pos/captain/meja/$tableId/tinjau — review, hold or send the table's draft.
export const Route = createFileRoute("/_ops/pos/captain/meja/$tableId/tinjau")({
  beforeLoad: captainOrderGuard(),
  component: ReviewRoute,
});

function ReviewRoute() {
  const { tableId } = Route.useParams();
  return <ReviewScreen tableId={tableId} />;
}
