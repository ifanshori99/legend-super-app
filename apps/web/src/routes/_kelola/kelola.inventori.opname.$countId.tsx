import { createFileRoute } from "@tanstack/react-router";
import { CountDetailPage } from "@/features/ws06-inventory/components/count-detail-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { countQuery } from "@/features/ws06-inventory/opname-queries";
import { ApiError } from "@/lib/api/errors";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/opname/$countId — blind count on a phone, variance
// review, approval by a different person (INV-03), then posting.
export const Route = createFileRoute(
  "/_kelola/kelola/inventori/opname/$countId",
)({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: async ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return;
    try {
      await context.queryClient.ensureQueryData(
        countQuery({ stockCountId: params.countId }),
      );
    } catch (error) {
      // A stale link lands on the page's own not-found state; only a genuine
      // server failure becomes the route error boundary.
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  },
  component: CountDetailScreen,
});

function CountDetailScreen() {
  const { countId } = Route.useParams();
  const { access, session } = Route.useRouteContext();
  return (
    <InventoryPage active="opname">
      <CountDetailPage
        stockCountId={countId}
        canCount={holdsAny(access, ["inventory.opname.count"])}
        canApprove={holdsAny(access, ["inventory.adjustment.approve"])}
        actorId={session?.user.id}
      />
    </InventoryPage>
  );
}
