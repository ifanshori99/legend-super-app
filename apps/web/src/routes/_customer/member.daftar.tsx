import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MemberSignupPage } from "@/features/ws08-member/components/signup-page";
import { preloadMemberOverviewOnly } from "@/features/ws08-member/loader";

const t = createTranslator();

// PRD §3.20 "Pendaftaran Member": verified WhatsApp + versioned consents.
export const Route = createFileRoute("/_customer/member/daftar")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("member.page.signup"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  loader: ({ context }) => preloadMemberOverviewOnly(context.queryClient),
  component: MemberSignupPage,
});
