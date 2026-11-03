import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PlatformSupportAccessPage } from "@/features/ws01-support-access/components/platform-page";
import { supportAccessGuard } from "@/features/ws01-support-access/guard";

const t = createTranslator();

// /platform/akses-dukungan — Super Admin opens and ends support sessions
// (bead legend-335; PRD §3 F4 "Support Access", TEN-04).
export const Route = createFileRoute("/_platform/platform/akses-dukungan")({
  beforeLoad: supportAccessGuard("back_office", [
    "platform.support_access.request",
  ]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("supportAccess.platform.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PlatformSupportAccessPage,
});
