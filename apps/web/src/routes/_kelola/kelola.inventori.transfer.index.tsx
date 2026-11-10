import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { TransfersPage } from "@/features/ws06-inventory/components/transfers-page";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";

// /kelola/inventori/transfer — recent internal transfers (PRD §16).
export const Route = createFileRoute("/_kelola/kelola/inventori/transfer/")({
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
        ]),
  component: TransfersScreen,
});

function TransfersScreen() {
  return (
    <InventoryPage active="transfers">
      <TransfersPage />
    </InventoryPage>
  );
}
