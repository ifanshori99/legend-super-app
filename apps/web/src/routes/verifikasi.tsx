import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { returnPathSchema } from "@starter/shared/identity";
import { createTranslator } from "@starter/shared/i18n";
import { MfaVerifyPage } from "@/features/ws01-auth/components/mfa-verify-page";
import { safeReturnTo } from "@/features/ws01-auth/state";

const t = createTranslator();

// Second-factor step for staff (bead legend-9bh; PRD §3 F6 "Staf — Login Web",
// AUTH-05). Outside every area on purpose: the area layouts redirect a session
// that still owes the second factor here, so the page must not be guarded by
// that same gate.
export const Route = createFileRoute("/verifikasi")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("staffAuth.verify.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: z.object({
    // Only a path on this app, and never back into the login flow.
    returnTo: returnPathSchema.optional().catch(undefined),
  }),
  component: VerifyRoute,
});

function VerifyRoute() {
  const { returnTo } = Route.useSearch();
  return <MfaVerifyPage returnTo={safeReturnTo(returnTo)} />;
}
