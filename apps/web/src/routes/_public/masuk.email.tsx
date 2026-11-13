import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { z } from "zod";
import { safeReturnPath } from "@/features/ws01-login/flow";
import { EmailLoginScreen } from "@/features/ws01-login/components/email-login";

// "/masuk/email" — magic-link request (PRD v1.7 §5; §3 F3). The answer never
// says whether the address exists, so the page has one outcome for every email.
const t = createTranslator();

const searchSchema = z.object({
  lanjut: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === "string" ? safeReturnPath(v) : undefined)),
});

export const Route = createFileRoute("/_public/masuk/email")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.email.heading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EmailRoute,
});

function EmailRoute() {
  const { lanjut } = Route.useSearch();
  return <EmailLoginScreen returnTo={lanjut} />;
}
