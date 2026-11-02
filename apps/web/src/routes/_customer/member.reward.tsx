import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberRewardsPage } from "@/features/ws08-member/components/rewards-page";
import { preloadMemberRewards } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Reward Katalog" + LOY-03 (atomic redemption).
export const Route = createFileRoute("/_customer/member/reward")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.rewards"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberRewards(context.queryClient),
  component: MemberRewardsPage,
});
