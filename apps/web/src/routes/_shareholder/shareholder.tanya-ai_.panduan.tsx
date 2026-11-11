import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { AiGuidePage } from "@/features/ws12-ai-guide/components/guide-page";

const t = createTranslator();

// /shareholder/tanya-ai/panduan — Pedoman Penggunaan AI (PRD v1.7 §3 F40 Transparansi). Any
// signed-in user of the area; the area layout already runs the guard.
export const Route = createFileRoute(
  "/_shareholder/shareholder/tanya-ai_/panduan",
)({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiGuide.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => <AiGuidePage backHref="/shareholder/tanya-ai" />,
});
