import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PayslipDetail } from "@/features/ws10-payslip/components/payslip-detail";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/slip-gaji/$payslipId" — one payslip behind the 6-digit PIN gate
// (PRD v1.7 §3 F30: "dilindungi PIN", unduh PDF; HR-03 salary data).
const t = createTranslator();

export const Route = createFileRoute(
  "/_karyawan/karyawan/slip-gaji/$payslipId",
)({
  beforeLoad: selfServiceGuard(["self.payslip.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslip.detail.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PayslipDetailRoute,
});

function PayslipDetailRoute() {
  const { payslipId } = Route.useParams();
  // A different payslip gets a fresh gate: the opened body is component state,
  // never a cached query, so no PIN survives a navigation.
  return <PayslipDetail key={payslipId} payslipId={payslipId} />;
}
