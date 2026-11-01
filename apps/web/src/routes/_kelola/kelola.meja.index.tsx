import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { FloorEditorPage } from "@/features/ws03-floor-editor/components/floor-editor-page";
import { floorGuard } from "@/features/ws03-floor-editor/guard";

const t = createTranslator();

// Kelola · Denah & Meja (PRD §3 F9). The kelola layout already ran the area
// guard; editing zones and tables needs floor.table.manage as well.
export const Route = createFileRoute("/_kelola/kelola/meja/")({
  beforeLoad: floorGuard(["floor.table.manage"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("floor.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: FloorEditorPage,
});
