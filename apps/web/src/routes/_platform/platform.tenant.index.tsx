import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import { TenantListPage } from "@/features/ws01-platform-tenants/components/tenant-list-page";

const t = createTranslator();

// Panel Platform tenant list (bead legend-tno; PRD §3 F1 "Layar Platform").
export const Route = createFileRoute("/_platform/platform/tenant/")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformTenants.nav.tenants" as MessageKey),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TenantListPage,
});
