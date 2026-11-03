import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import { tenantGuard } from "@/features/ws01-platform-tenants/guard";
import { TenantDetailPage } from "@/features/ws01-platform-tenants/components/tenant-detail-page";

const t = createTranslator();

// Tenant detail (bead legend-tno; PRD §3 F1, §3 F4).
export const Route = createFileRoute("/_platform/platform/tenant/$tenantId")({
  beforeLoad: tenantGuard,
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformTenants.detail.title" as MessageKey),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TenantScreen,
});

function TenantScreen() {
  const { tenantId } = Route.useParams();
  return <TenantDetailPage tenantId={tenantId} />;
}
