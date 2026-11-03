import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { TenantSupportAccessPage } from "@/features/ws01-support-access/components/tenant-page";
import { supportAccessGuard } from "@/features/ws01-support-access/guard";

const t = createTranslator();

// /kelola/akses-dukungan — the tenant admin reads support sessions on their
// tenant (bead legend-335; PRD §3 F4, TEN-04).
export const Route = createFileRoute("/_kelola/kelola/akses-dukungan")({
  beforeLoad: supportAccessGuard("dashboard", ["audit.log.view"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("supportAccess.tenant.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TenantSupportAccessPage,
});
