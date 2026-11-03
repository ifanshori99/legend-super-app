import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { CleaningScreen } from "@/features/facility-staff/components/cleaning-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /fasilitas/kebersihan — the cleaning queue and checklist (bead legend-1oi9;
// PRD v1.7 §3 F25 "Siklus Kebersihan", FAC-06). `?taskId=` opens the checklist
// dialog for one task (the board's "Selesai dibersihkan" action links here).
const searchSchema = z.object({
  facilityId: z.uuid().optional().catch(undefined),
  taskId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/fasilitas/kebersihan")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["facility.booth.operate"],
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
            page: t("facilityStaff.cleaning.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: CleaningRoute,
});

function CleaningRoute() {
  const search = Route.useSearch();
  return (
    <CleaningScreen facilityId={search.facilityId} taskId={search.taskId} />
  );
}
