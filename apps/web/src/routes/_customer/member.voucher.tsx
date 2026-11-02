import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberVouchersPage } from "@/features/ws08-member/components/vouchers-page";
import { preloadMemberVouchers } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Halaman Member": voucher.
export const Route = createFileRoute("/_customer/member/voucher")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.vouchers"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberVouchers(context.queryClient),
  component: MemberVouchersPage,
});
