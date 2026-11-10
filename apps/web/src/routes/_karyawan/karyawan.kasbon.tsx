import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { KasbonPage } from "@/features/ws10-payslip/components/kasbon-page";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/kasbon" — the employee's kasbon list and request form (PRD v1.7
// §3 F31 "Kasbon: pengajuan pinjaman dengan batas maksimal, approval, dan
// cicilan otomatis dipotong dari payroll"; HR-01 own rows only). Guarded by
// `self.loan.request` (legend-e3k9).
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/kasbon")({
  beforeLoad: selfServiceGuard(["self.loan.request"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslip.kasbon.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: KasbonPage,
});
