import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { TanyaAiPage } from "@/features/ws12-ai-chat/components/tanya-ai-page";
import { aiChatGuard } from "@/features/ws12-ai-chat/guard";

const t = createTranslator();

// /owner/tanya-ai — Tanya AI chat (PRD v1.7 §3 Fitur 38, legend-mlnu). The area layout
// guards the area; this page needs `ai.ask`, and the API re-checks every ask.
export const Route = createFileRoute("/_owner/owner/tanya-ai")({
  beforeLoad: aiChatGuard("dashboard"),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiChat.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => <TanyaAiPage area="owner" />,
});
