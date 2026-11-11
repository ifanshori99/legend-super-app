import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { accessGuard } from "@/features/ws01-access/guard";
import { AiAdminPage } from "@/features/ws12-ai-admin/components/ai-admin-page";

const t = createTranslator();

// /kelola/pengaturan/mcp-ai — AI and MCP admin (bead legend-hi82): service
// switches, MCP clients, quota and cap. No loader: every card is a client
// query, so mock scenarios (?mock=empty|error|offline) reach the browser.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/mcp-ai/")({
  beforeLoad: accessGuard(["ai.governance.manage", "mcp.client.manage"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiAdmin.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AiAdminScreen,
});

function AiAdminScreen() {
  const { access } = Route.useRouteContext();
  return <AiAdminPage access={access} />;
}
