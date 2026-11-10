import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PinChange } from "@/features/ws10-payslip/components/pin-change";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/slip-gaji/ubah-pin" — change the payslip PIN with the current one
// (bead legend-ilzrj, mockup ubah-pin). Same permission as the payslip list.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/slip-gaji/ubah-pin")({
  beforeLoad: selfServiceGuard(["self.payslip.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslipPin.ubahPin.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ChangePinRoute,
});

function ChangePinRoute() {
  const navigate = useNavigate();
  return (
    <PinChange onDone={() => void navigate({ to: "/karyawan/slip-gaji" })} />
  );
}
