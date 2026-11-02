import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ReimbursementPage } from "@/features/ws10-payslip/components/reimbursement-page";
import { selfServiceGuard } from "@/features/ws10-payslip/guard";

// "/karyawan/reimbursement" — the employee's claims and photo-backed request
// form (PRD v1.7 §3 F31 "Klaim dengan foto bukti ... pembayaran melalui
// payroll atau kas"; HR-01 own rows only).
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/reimbursement")({
  beforeLoad: selfServiceGuard(["self.reimbursement.request"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payslip.reimbursement.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReimbursementPage,
});
