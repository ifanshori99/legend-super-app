import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { preloadMemberOverviewOnly } from "@/features/ws08-member/loader";
import { TukarPoinPage } from "@/features/member-tukar-poin/components/tukar-poin-page";

const t = createTranslator();

// Redeem points on the open bill at the till (brief 1165, flow A). Only the
// overview is preloaded: bills and quotes change at the till at any moment, so
// the page reads them fresh in the browser instead of serving an SSR snapshot.
export const Route = createFileRoute("/_customer/member/tukar-poin")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.tukarPoin"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberOverviewOnly(context.queryClient),
  component: TukarPoinPage,
});
