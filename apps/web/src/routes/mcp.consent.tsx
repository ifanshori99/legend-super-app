import { createFileRoute, redirect } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { McpConsentPage } from "@/features/ws12-ai-consent/components/consent-page";
import { signInPath } from "@/features/ws01-login/flow";

// "/mcp/consent" (legend-39d.1): where GET /oauth/authorize sends the browser of
// a person connecting an MCP client. Outside every area on purpose: it belongs
// to the connection, not to a role's screens. The OAuth query is in the URL
// (state, code challenge), so the page is never cached, sends no referrer and
// is not indexed. A signed-out visitor signs in first and returns here.
const t = createTranslator();

export const Route = createFileRoute("/mcp/consent")({
  beforeLoad: ({ context, location }) => {
    if (!context.session)
      throw redirect({
        href: signInPath(`${location.pathname}${location.searchStr}`),
      });
  },
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
