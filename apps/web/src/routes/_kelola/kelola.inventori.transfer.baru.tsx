import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { TransferFormPage } from "@/features/ws06-inventory/components/transfer-form-page";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  balancesQuery,
  itemsQuery,
  locationsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/queries";

// /kelola/inventori/transfer/baru — new inter-location transfer (PRD §16).
export const Route = createFileRoute("/_kelola/kelola/inventori/transfer/baru")(
  {
    loader: ({ context, location }) =>
      isMockScenarioRequest(location.searchStr)
        ? undefined
        : Promise.all([
            context.queryClient.ensureQueryData(
              locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
            ),
            context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
            context.queryClient.ensureQueryData(
              balancesQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
            ),
            context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
          ]),
    component: TransferFormScreen,
  },
);

function TransferFormScreen() {
  return (
    <InventoryPage active="transfers">
      <TransferFormPage />
    </InventoryPage>
  );
}
