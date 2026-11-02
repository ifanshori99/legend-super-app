import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { returnPathSchema } from "@starter/shared/identity";
import { z } from "zod";
import { SignInScreen } from "@/features/ws01-login/components/sign-in-screen";

// "/masuk" — customer and staff sign-in (PRD v1.7 §5: dynamic, no-store,
// noindex; §3 F3; alur C). `lanjut` is where the visitor came from; it may only
// be a path on this app (open redirect is rejected by the contract rule).
const t = createTranslator();

const searchSchema = z.object({
  lanjut: returnPathSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_public/masuk/")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("login.eyebrow"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SignInRoute,
});

function SignInRoute() {
  const { lanjut } = Route.useSearch();
  return <SignInScreen returnTo={lanjut} />;
}
