import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MyRequestsPage } from "@/features/hris-requests/components/my-requests-page";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/pengajuan" — the employee's own swap, leave and overtime requests
// with their status (bead legend-ydf2; HR-01 own rows only). Guarded by
// `self.leave.request`.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/pengajuan/")({
  beforeLoad: selfServiceGuard(["self.leave.request"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("hrisRequestsMine.list.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MyRequestsPage,
});
