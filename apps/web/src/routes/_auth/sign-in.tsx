import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth-form";
import { createTranslator } from "@starter/shared/i18n";

const staticT = createTranslator();

export const Route = createFileRoute("/_auth/sign-in")({
  head: () => ({
    meta: [{ title: `Sign in | ${staticT("app.defaultBrand")}` }],
  }),
  component: () => <AuthForm mode="sign-in" />,
});
