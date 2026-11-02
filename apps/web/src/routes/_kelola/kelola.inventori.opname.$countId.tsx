import { createFileRoute } from "@tanstack/react-router";
import { CountDetailPage } from "@/features/ws06-inventory/components/count-detail-page";
import { OpnamePage } from "@/features/ws06-inventory/components/opname-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/opname-lib";
import { countQuery } from "@/features/ws06-inventory/queries";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/opname/$countId — blind count on a phone, variance
// review, approval by a different person (INV-03), then posting.
export const Route = createFileRoute(
  "/_kelola/kelola/inventori/opname/$countId",
)({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location, params }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(
          countQuery({ stockCountId: params.countId }),
        ),
  component: CountDetailScreen,
});

function CountDetailScreen() {
  const { countId } = Route.useParams();
  const { access, session } = Route.useRouteContext();
  return (
    <OpnamePage active="counts">
      <CountDetailPage
        stockCountId={countId}
        canCount={holdsAny(access, ["inventory.opname.count"])}
        canApprove={holdsAny(access, ["inventory.adjustment.approve"])}
        actorId={session?.user.id}
      />
    </OpnamePage>
  );
}
