import { createFileRoute } from "@tanstack/react-router";
import { VouchersPage } from "@/features/ws08-promo/components/vouchers-page";
import { PromoPage } from "@/features/ws08-promo/components/promo-shell";
import { promoGuard } from "@/features/ws08-promo/guard";
import { isMockScenarioRequest } from "@/features/ws08-promo/lib";
import { vouchersQuery } from "@/features/ws08-promo/queries";

// /kelola/promo/voucher — issued voucher codes, issue and validate.
export const Route = createFileRoute("/_kelola/kelola/promo/voucher")({
  beforeLoad: promoGuard(["promo.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(vouchersQuery()),
  component: VouchersScreen,
});

function VouchersScreen() {
  return (
    <PromoPage active="vouchers">
      <VouchersPage />
    </PromoPage>
  );
}
