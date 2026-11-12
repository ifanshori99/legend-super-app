import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { HolidayPage } from "@/features/hris-requests/components/holiday-page";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/libur" — the holiday calendar, read only (bead legend-ydf2).
// Guarded by `self.schedule.view`.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/libur")({
  beforeLoad: selfServiceGuard(["self.schedule.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("hrisRequestsMine.holiday.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HolidayPage,
});
