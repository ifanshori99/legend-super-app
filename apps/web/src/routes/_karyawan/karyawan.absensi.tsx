import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { attendanceTypeSchema } from "@starter/shared/hris";
import { AttendanceClock } from "@/features/ws10-hris-employee/components/attendance-clock";
import { evaluateGuard } from "@/lib/areas/guard";

// "/karyawan/absensi" — the attendance clock (PRD v1.7 §3 F25, §4 Alur L).
// The Beranda links here with the clock type it derived from today's logs; the
// page guard needs the self-service clock permission on top of the area gate.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/absensi")({
  validateSearch: z.object({
    type: attendanceTypeSchema.catch("in").default("in"),
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
          page: t("hris.attendance.title", { type: t("hris.type.in") }),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AttendanceClockRoute,
});

function AttendanceClockRoute() {
  const { type } = Route.useSearch();
  return <AttendanceClock type={type} />;
}
