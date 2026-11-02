import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { AttendanceHistory } from "@/features/ws10-hris-employee/components/attendance-history";
import { evaluateGuard } from "@/lib/areas/guard";

// "/karyawan/absensi/riwayat" — this employee's logs and correction requests
// (PRD v1.7 §3 F25 "Koreksi Absensi"). The Beranda links straight to the
// corrections tab when it has a running request.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/absensi/riwayat")({
  validateSearch: z.object({
    tab: z.enum(["logs", "corrections"]).catch("logs").default("logs"),
  }),
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "hris",
        anyOf: ["self.attendance.clock"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("hris.history.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AttendanceHistoryRoute,
});

function AttendanceHistoryRoute() {
  const { tab } = Route.useSearch();
  return <AttendanceHistory initialTab={tab} />;
}
