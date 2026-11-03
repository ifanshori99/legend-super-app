import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { AuditPage } from "@/features/ws01-platform-ops/components/audit-page";
import {
  AUDIT_PERMISSIONS,
  opsGuard,
} from "@/features/ws01-platform-ops/guard";

const t = createTranslator();

// /platform/audit — cross-tenant audit list (bead legend-y6s).
export const Route = createFileRoute("/_platform/platform/audit")({
  beforeLoad: opsGuard(AUDIT_PERMISSIONS),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformOps.audit.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuditPage,
});
