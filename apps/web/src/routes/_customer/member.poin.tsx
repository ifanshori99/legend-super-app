import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberPointsPage } from "@/features/ws08-member/components/points-page";
import { preloadMemberPoints } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Poin" + LOY-01 (append-only ledger).
export const Route = createFileRoute("/_customer/member/poin")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.points"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberPoints(context.queryClient),
  component: MemberPointsPage,
});
