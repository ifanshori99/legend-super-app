import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { HealthPage } from "@/features/ws01-platform-ops/components/health-page";
import {
  KESEHATAN_PERMISSIONS,
  opsGuard,
} from "@/features/ws01-platform-ops/guard";

const t = createTranslator();

// /platform/kesehatan — platform health tiles (bead legend-y6s).
export const Route = createFileRoute("/_platform/platform/kesehatan")({
  beforeLoad: opsGuard(KESEHATAN_PERMISSIONS),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformOps.health.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HealthPage,
});
