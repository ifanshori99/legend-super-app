import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { OpenBillPolicyPage } from "@/features/open-bill/components/open-bill-policy-page";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/pengaturan/open-bill — per-outlet open-bill policy (bead legend-2zb5;
// PRD v1.7 §3 F43). The `pengaturan_` segment keeps this screen out of the
// settings hub's own layout. Step 1 guard is `floor.table.manage` (held by
// tenant_admin, general_manager and outlet_manager); step 2 swaps it for a
// narrower permission together with the API route. No loader: the policy is a
// client query so `?mock=offline|error` reaches the browser fetch.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/open-bill")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["floor.table.manage"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("openBillPolicy.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OpenBillPolicyPage,
});
