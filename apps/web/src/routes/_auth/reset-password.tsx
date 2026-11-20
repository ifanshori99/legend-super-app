import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { z } from "zod";
import { ResetPasswordScreen } from "@/features/ws01-login/components/reset-password";

// "/reset-password?token=…" — the page the reset mail opens (legend-1255). The
// token never leaves the address bar except in the POST body, and the page is
// never cached or indexed.
const t = createTranslator();

const searchSchema = z.object({
  token: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === "string" && v ? v : undefined)),
});

export const Route = createFileRoute("/_auth/reset-password")({
  validateSearch: searchSchema,
  headers: () => ({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.resetPassword.newHeading"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ResetRoute,
});

function ResetRoute() {
  const { token } = Route.useSearch();
  return <ResetPasswordScreen token={token} />;
}
