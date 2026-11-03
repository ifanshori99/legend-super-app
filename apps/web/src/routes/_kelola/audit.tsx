import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { AuditPage } from "@/features/ws11-audit/components/audit-page";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /audit — audit log viewer (PRD v1.7 §3 F36 "Audit Log Viewer"). The kelola
// layout runs the management guard; this page additionally needs
// `audit.log.view` (docs/frontend.md "Page guard"). The API re-checks it. No
// loader: the list is a filtered, paged client query, and mock scenarios
// (?mock=empty|error|offline) must reach the browser fetch.
export const Route = createFileRoute("/_kelola/audit")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["audit.log.view"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("auditSettings.audit.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuditPage,
});
