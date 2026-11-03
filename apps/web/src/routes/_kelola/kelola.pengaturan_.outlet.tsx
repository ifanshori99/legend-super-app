import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { OutletSettingsPage } from "@/features/ws01-org/components/outlet-settings-page";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/pengaturan/outlet — outlet settings (bead legend-1mi5; PRD v1.7 §3
// "Pengaturan", owner Q39). The `pengaturan_` segment keeps this screen out of
// the settings hub's own layout (the hub is a link list, not a wrapper). The
// kelola layout runs the management guard; this page additionally needs
// `org.structure.manage`, the same permission the API checks on the org
// routes. No loader: the list is a client query so `?mock=offline|error`
// reaches the browser fetch.
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/outlet")({
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
          page: t("auditSettings.hub.groups.outlet"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OutletSettingsPage,
});
