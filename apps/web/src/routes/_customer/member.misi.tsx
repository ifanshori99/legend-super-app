import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberMissionsPage } from "@/features/ws08-member/components/missions-page";
import { preloadMemberMissions } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Mission" (behaviour missions and stamp cards).
export const Route = createFileRoute("/_customer/member/misi")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.missions"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberMissions(context.queryClient),
  component: MemberMissionsPage,
});
