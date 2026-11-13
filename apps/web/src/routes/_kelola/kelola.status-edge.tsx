import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { EdgeNodesPage } from "@/features/ws02-edge/components/edge-nodes-page";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/status-edge — back-office edge nodes and receipt-run alert (bead
// legend-ph62j, mockup receipt-run-s7szu). The kelola layout runs the
// management guard; this page additionally needs `report.operational.view`,
// the permission of the POS connectivity screen. No loader: the list is a
// client query (a probe of live node state, not SSR data).
export const Route = createFileRoute("/_kelola/kelola/status-edge")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["report.operational.view"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("edgeNodes.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EdgeNodesPage,
});
