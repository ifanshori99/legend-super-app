import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { BoardScreen } from "@/features/facility-staff/components/board-screen";
import { evaluateGuard } from "@/lib/areas/guard";
import { showerGate } from "@/lib/areas/shower-gate";

// /fasilitas — the tablet-first booth status board (bead legend-1oi9; PRD v1.7
// §3 F25 "Siklus Kebersihan", FAC-06). The guard is presentation only; the API
// re-checks every request. `?facilityId=` lets a multi-facility tenant open one
// board directly (the e2e spec uses it too).
const searchSchema = z.object({
  facilityId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/fasilitas/")({
  validateSearch: searchSchema,
  beforeLoad: ({ context }) => {
    showerGate();
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
            page: t("facilityStaff.board.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: BoardRoute,
});

function BoardRoute() {
  const search = Route.useSearch();
  return <BoardScreen facilityId={search.facilityId} />;
}
