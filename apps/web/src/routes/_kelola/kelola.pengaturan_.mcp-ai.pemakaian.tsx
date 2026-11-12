import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { z } from "zod";
import { accessGuard } from "@/features/ws01-access/guard";
import { UsagePage } from "@/features/ws12-ai-admin/usage-page";

const t = createTranslator();

// /kelola/pengaturan/mcp-ai/pemakaian — tenant AI usage of a month, MCP tokens
// and the tool-call audit (bead legend-hi82; PRD §3 Fitur 40, AIG-02, MCP-03).
// The API re-checks ai.governance.manage and mcp.client.manage per request.
export const Route = createFileRoute(
  "/_kelola/kelola/pengaturan_/mcp-ai/pemakaian",
)({
  beforeLoad: accessGuard(["ai.governance.manage", "mcp.client.manage"]),
  validateSearch: z.object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .catch(undefined),
  }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiAdminUsage.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: UsageScreen,
});

function UsageScreen() {
  const { month } = Route.useSearch();
  return <UsagePage month={month} />;
}
