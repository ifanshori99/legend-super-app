import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import {
  SettingsHubError,
  SettingsHubPage,
  SettingsHubPending,
} from "@/features/ws11-audit/components/settings-hub-page";

const t = createTranslator();

// /kelola/pengaturan — settings hub (PRD v1.7 §3 "Pengaturan"): links every
// tenant, brand and outlet configuration screen. Each linked screen keeps its
// own permission guard; the hub only lists screens that exist in this build.
export const Route = createFileRoute("/_kelola/kelola/pengaturan")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("auditSettings.hub.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SettingsHubPage,
  pendingComponent: SettingsHubPending,
  errorComponent: ({ reset }) => <SettingsHubError reset={reset} />,
});
