import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { accessGuard } from "@/features/ws01-access/guard";
import { AiSettingsPage } from "@/features/ws12-ai-settings/components/ai-settings-page";

const t = createTranslator();

// /kelola/pengaturan/ai — tenant AI settings (bead legend-nnufz): ChatGPT login,
// custom model fallback, monthly budget. No loader: every card is a client
// query, so mock scenarios (?mock=empty|error|offline) reach the browser.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/ai")({
  beforeLoad: accessGuard(["ai.governance.manage"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiSettings.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AiSettingsScreen,
});

function AiSettingsScreen() {
  return <AiSettingsPage />;
}
