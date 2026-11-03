import { createFileRoute } from "@tanstack/react-router";
import { SupplierDetailPage } from "@/features/ws06-purchasing/components/supplier-detail-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  inventoryItemsQuery,
  uomsQuery,
} from "@/features/ws06-purchasing/queries";
import {
  supplierCatalogQuery,
  supplierDetailQuery,
  supplierPerformanceQuery,
  supplierPriceHistoryQuery,
} from "@/features/ws06-purchasing/supplier-queries";
import {
  catalogItemIds,
  currentMonthRange,
  isMockScenarioRequest,
} from "@/features/ws06-purchasing/supplier-lib";

// /kelola/pengadaan/supplier/$supplierId — one supplier's detail (bead
// legend-xjb; PRD v1.7 §3 F18 "Supplier"). The trailing `_` keeps this route
// outside /kelola/pengadaan's own screen (see supplier.index.tsx).
export const Route = createFileRoute(
  "/_kelola/kelola/pengadaan_/supplier/$supplierId",
)({
  beforeLoad: purchasingGuard(["purchasing.supplier.manage"]),
  loader: async ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return;
    try {
      const { fromDate, toDate } = currentMonthRange();
      await Promise.all([
        context.queryClient.ensureQueryData(
          supplierDetailQuery(params.supplierId),
        ),
        context.queryClient.ensureQueryData(inventoryItemsQuery()),
        context.queryClient.ensureQueryData(uomsQuery()),
        context.queryClient.ensureQueryData(
          supplierPerformanceQuery(params.supplierId, fromDate, toDate),
        ),
      ]);
      const catalog = await context.queryClient.ensureQueryData(
        supplierCatalogQuery(params.supplierId),
      );
      await Promise.all(
        catalogItemIds(catalog.data).map((inventoryItemId) =>
          context.queryClient.ensureQueryData(
            supplierPriceHistoryQuery(params.supplierId, inventoryItemId),
          ),
        ),
      );
    } catch {
      // The page renders not-found and error states with their own retry.
    }
  },
  component: SupplierDetailScreen,
});

function SupplierDetailScreen() {
  const { supplierId } = Route.useParams();
  return (
    <PurchasingFrame active="suppliers">
      <SupplierDetailPage supplierId={supplierId} />
    </PurchasingFrame>
  );
}
