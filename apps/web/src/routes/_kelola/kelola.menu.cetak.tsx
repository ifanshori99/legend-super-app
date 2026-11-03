import { createFileRoute } from "@tanstack/react-router";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { MenuPrintPage } from "@/features/ws03-menu/components/menu-print-page";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import {
  categoriesQuery,
  itemsQuery,
  priceListsQuery,
} from "@/features/ws03-menu/queries";

// /kelola/menu/cetak — printable menu (PRD §8 "Menu Cetak Otomatis"; PRD
// v1.7 §3 F8). Reads active items and the dine-in prices; "Cetak / Simpan PDF"
// is the browser's print dialog.
export const Route = createFileRoute("/_kelola/kelola/menu/cetak")({
  beforeLoad: menuGuard(["menu.item.view", "menu.price.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(categoriesQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(priceListsQuery({ limit: 100 })),
        ]),
  component: PrintScreen,
});

function PrintScreen() {
  return (
    <MenuPage active="print">
      <MenuPrintPage />
    </MenuPage>
  );
}
