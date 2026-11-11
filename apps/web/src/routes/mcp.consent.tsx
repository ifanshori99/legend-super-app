import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { McpConsentPage } from "@/features/ws12-ai-consent/components/consent-page";

// "/mcp/consent" (legend-39d.1): where GET /oauth/authorize sends the browser of
// a person connecting an MCP client. Outside every area on purpose: it belongs
// to the connection, not to a role's screens. The OAuth query is in the URL
// (state, code challenge), so the page is never cached, sends no referrer and
// is not indexed. A signed-out visitor sees a sign-in state on the page: the
// OAuth query is parked in sessionStorage (it is too long for the sign-in
// return path) and the page resumes from there after sign-in.
const t = createTranslator();

export const Route = createFileRoute("/mcp/consent")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiConsent.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: McpConsentPage,
});
