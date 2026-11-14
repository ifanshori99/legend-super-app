import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { EmergencyScreen } from "@/features/facility-staff/components/emergency-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /fasilitas/darurat — the emergency alert screen (bead legend-1oi9; PRD v1.7
// §3 F25 "Keselamatan", FAC-08).
const searchSchema = z.object({
  facilityId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/fasilitas/darurat")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["facility.emergency.respond"],
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
            page: t("facilityStaff.emergency.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: EmergencyRoute,
});

function EmergencyRoute() {
  const search = Route.useSearch();
  return <EmergencyScreen facilityId={search.facilityId} />;
}
