import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { DomainSettingsPage } from "@/features/ws01-org/components/domain-settings-page";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/pengaturan/domain — custom-domain verification (bead legend-az8z5;
// PRD v1.7 §3 F4 "Domain", TEN-08). Same shape as the outlet settings route:
// the `pengaturan_` segment keeps it out of the hub's layout, the kelola
// layout runs the management guard and this page additionally needs
// `org.structure.manage`. No loader: the list is a client query.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/domain")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["org.structure.manage"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: "Domain kustom",
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DomainSettingsPage,
});
