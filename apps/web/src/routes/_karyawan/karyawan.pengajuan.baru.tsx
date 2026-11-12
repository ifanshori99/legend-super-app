import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { RequestFormPage } from "@/features/hris-requests/components/request-form-page";
import { parseFormTab } from "@/features/hris-requests/components/request-form-logic";
import { evaluateGuard } from "@/lib/areas/guard";

// "/karyawan/pengajuan/baru" — new shift swap / leave / overtime request
// (legend-ydf2 HR-05). `?jenis=swap|leave|overtime` picks the tab. Guarded by
// the request permissions of its tabs (the page hides tabs the account lacks);
// the API re-checks.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/pengajuan/baru")({
  validateSearch: z.object({
    jenis: z.enum(["swap", "leave", "overtime"]).catch("swap").default("swap"),
  }),
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "hris",
        anyOf: [
          "self.leave.request",
          "self.shift_swap.request",
          "self.attendance.clock",
          "self.profile.view",
          "hr.employee.manage",
        ],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("hrisRequestsEmployee.form.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NewRequestRoute,
});

function NewRequestRoute() {
  const { jenis } = Route.useSearch();
  const { access } = Route.useRouteContext();
  return <RequestFormPage access={access} initialTab={parseFormTab(jenis)} />;
}
