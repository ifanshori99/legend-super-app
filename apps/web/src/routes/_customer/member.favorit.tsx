import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberFavoritesPage } from "@/features/ws08-member/components/favorites-page";
import { preloadMemberFavorites } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Halaman Member": favorit.
export const Route = createFileRoute("/_customer/member/favorit")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.favorites"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberFavorites(context.queryClient),
  component: MemberFavoritesPage,
});
