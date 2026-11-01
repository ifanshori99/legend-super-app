import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { QrPage } from "@/features/ws03-floor-editor/components/qr-page";
import { floorGuard } from "@/features/ws03-floor-editor/guard";

const t = createTranslator();

// Kelola · QR meja (PRD §3 F9 "Meja": QR permanen per meja). Issuing a QR
// rotates the table's signed token, so it needs the same write permission as
// the floor editor.
export const Route = createFileRoute("/_kelola/kelola/meja/qr")({
  beforeLoad: floorGuard(["floor.table.manage"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("floor.qrTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: QrPage,
});
