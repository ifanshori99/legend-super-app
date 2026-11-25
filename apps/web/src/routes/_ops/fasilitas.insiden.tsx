import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { IncidentScreen } from "@/features/facility-staff/components/incident-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /fasilitas/insiden — the incident log plus raise/respond (bead legend-1oi9;
// PRD v1.7 §3 F25 "Keselamatan", FAC-08).
const searchSchema = z.object({
  facilityId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/fasilitas/insiden")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["facility.access.assist"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => {
    const t = createTranslator();
    return {
      meta: [
        {
          title: t("app.titleTemplate", {
            page: t("facilityStaff.incident.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: IncidentRoute,
});

function IncidentRoute() {
  const search = Route.useSearch();
  return <IncidentScreen facilityId={search.facilityId} />;
}
