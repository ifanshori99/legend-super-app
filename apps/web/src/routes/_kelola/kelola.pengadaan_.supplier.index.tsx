import { createFileRoute } from "@tanstack/react-router";
import { SuppliersPage } from "@/features/ws06-purchasing/components/suppliers-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  supplierCatalogQuery,
  supplierListQuery,
} from "@/features/ws06-purchasing/supplier-queries";
import {
  isMockScenarioRequest,
  SUPPLIER_PAGE_SIZE,
} from "@/features/ws06-purchasing/supplier-lib";

// /kelola/pengadaan/supplier — supplier master data (bead legend-xjb; PRD
// v1.7 §3 F18 "Supplier"). The file name escapes the pengadaan route with a
// trailing `_` (same as the PO print route): /kelola/pengadaan already renders
// its own screen and has no <Outlet>, so the supplier route must not nest
// under it. The URL is still /kelola/pengadaan/supplier.
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/supplier/")({
  beforeLoad: purchasingGuard(["purchasing.supplier.manage"]),
  loader: async ({ context, location }) => {
    // A scenario lives in the browser; a server prefetch would hide the state.
    if (isMockScenarioRequest(location.searchStr)) return;
    try {
      const list =
        await context.queryClient.ensureQueryData(supplierListQuery());
      // The catalog count column has no list projection in the contract; fill
      // it for the first page so SSR carries the numbers.
      await Promise.all(
        list.data
          .slice(0, SUPPLIER_PAGE_SIZE)
          .map((supplier) =>
            context.queryClient.ensureQueryData(
              supplierCatalogQuery(supplier.id),
            ),
          ),
      );
    } catch {
      // The page owns the error state and its retry.
    }
  },
  component: SuppliersScreen,
});

function SuppliersScreen() {
  return (
    <PurchasingFrame active="suppliers">
      <SuppliersPage />
    </PurchasingFrame>
  );
}
