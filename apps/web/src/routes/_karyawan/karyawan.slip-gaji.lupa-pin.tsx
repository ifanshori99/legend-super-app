import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PinForgot } from "@/features/ws10-payslip/components/pin-forgot";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/slip-gaji/lupa-pin" — forgotten payslip PIN: WhatsApp code or HR
// (bead legend-ilzrj). Same guard as the payslip screens.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/slip-gaji/lupa-pin")({
  beforeLoad: selfServiceGuard(["self.payslip.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslipPinForgot.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PinForgot,
});
