import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { magicLinkTokenSchema } from "@starter/shared/identity";
import { z } from "zod";
import { safeReturnPath } from "@/features/ws01-login/flow";
import { VerifyLinkScreen } from "@/features/ws01-login/components/verify-link";

// "/masuk/tautan" — the page an email sign-in link opens (PRD v1.7 §3 F3
// "Magic Link Email"). The token is in the query string, so this page sends no
// referrer and is never cached or indexed.
const t = createTranslator();

const searchSchema = z.object({
  token: magicLinkTokenSchema.optional().catch(undefined),
  lanjut: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === "string" ? safeReturnPath(v) : undefined)),
});

export const Route = createFileRoute("/_public/masuk/tautan")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.verify.heading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: VerifyRoute,
});

function VerifyRoute() {
  const { token, lanjut } = Route.useSearch();
  return <VerifyLinkScreen token={token} returnTo={lanjut} />;
}
