import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PayslipHistory } from "@/features/ws10-payslip/components/payslip-history";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/slip-gaji" — the employee's payslip history (PRD v1.7 §3 F30
// "Slip Gaji": riwayat, dilindungi PIN). The area layout supplies the Customer
// (Hangat) shell and the `self.profile.view` gate; this page adds
// `self.payslip.view`. No amounts are shown before the PIN.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/slip-gaji/")({
  beforeLoad: selfServiceGuard(["self.payslip.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslip.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PayslipHistory,
});
