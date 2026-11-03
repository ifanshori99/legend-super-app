import { createFileRoute } from "@tanstack/react-router";
import { MenuImportPage } from "@/features/ws03-menu/components/import-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { importReferencesQuery } from "@/features/ws03-menu/import-api";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";

// /kelola/menu/impor — bulk menu import (PRD §8 "Impor Massal"; PRD v1.7 §3
// F8). Importing writes items and prices, so the page needs both manage
// permissions; the API re-checks every write.
export const Route = createFileRoute("/_kelola/kelola/menu/impor")({
  beforeLoad: menuGuard(["menu.item.manage", "menu.price.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(importReferencesQuery),
  component: ImportScreen,
});

function ImportScreen() {
  return (
    <MenuPage active="import">
      <MenuImportPage />
    </MenuPage>
  );
}
