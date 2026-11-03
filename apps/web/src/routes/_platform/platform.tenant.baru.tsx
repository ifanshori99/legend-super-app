import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import { tenantGuard } from "@/features/ws01-platform-tenants/guard";
import { TenantWizardPage } from "@/features/ws01-platform-tenants/components/tenant-wizard-page";

const t = createTranslator();

// Create tenant wizard (bead legend-tno; PRD §4 Alur R).
export const Route = createFileRoute("/_platform/platform/tenant/baru")({
  beforeLoad: tenantGuard,
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformTenants.wizard.title" as MessageKey),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TenantWizardPage,
});
