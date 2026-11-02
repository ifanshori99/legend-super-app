import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberVisitsPage } from "@/features/ws08-member/components/visits-page";
import { preloadMemberVisits } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Halaman Member": riwayat kunjungan.
export const Route = createFileRoute("/_customer/member/kunjungan")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.visits"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberVisits(context.queryClient),
  component: MemberVisitsPage,
});
