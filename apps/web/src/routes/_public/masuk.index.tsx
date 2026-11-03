import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { signInReturnPath, signInSearch } from "@/features/ws01-login/flow";
import { SignInScreen } from "@/features/ws01-login/components/sign-in-screen";

// "/masuk" — customer and staff sign-in (PRD v1.7 §5: dynamic, no-store,
// noindex; §3 F3; alur C). `lanjut` is where the visitor came from; `redirect`
// is the alias captive portals and payment links use (bead legend-qhh5). Both
// may only be a path on this app (open redirect is refused before render).
const t = createTranslator();

export const Route = createFileRoute("/_public/masuk/")({
  validateSearch: signInSearch,
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
  const search = Route.useSearch();
  return <SignInScreen returnTo={signInReturnPath(search)} />;
}
