import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberOverviewPage } from "@/features/ws08-member/components/overview-page";
import { preloadMemberOverview } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Halaman Member": saldo poin, tier dan progres, mission aktif,
// reward, riwayat kunjungan, voucher, dan favorit in the customer PWA.
export const Route = createFileRoute("/_customer/member/")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.overview"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberOverview(context.queryClient),
  component: MemberOverviewPage,
});
