import { createFileRoute } from "@tanstack/react-router";
import { inventoryGuard } from "@/features/ws06-inventory/guard";

// /kelola/inventori/transfer — list and form share this guard; the list lives
// in transfer.index.tsx and the form in transfer.baru.tsx. A route without a
// component renders its <Outlet />.
export const Route = createFileRoute("/_kelola/kelola/inventori/transfer")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
});
