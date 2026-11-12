import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { OwnerRequestsPage } from "@/features/ws01-support-access/components/owner-requests-page";
import { supportAccessGuard } from "@/features/ws01-support-access/guard";

const t = createTranslator();

// /kelola/akses-dukungan/permintaan — the Owner decides read_write support
// access requests (bead legend-8r77t). The `_` after `akses-dukungan` keeps
// this route a sibling, so the tenant history page stays a leaf route.
export const Route = createFileRoute("/_kelola/kelola/akses-dukungan_/permintaan")({
  beforeLoad: supportAccessGuard("dashboard", ["org.support_access.approve"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("supportAccessOwner.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OwnerRequestsPage,
});
