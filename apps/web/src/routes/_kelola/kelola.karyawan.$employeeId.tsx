import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EmployeeProfilePage } from "@/features/ws10-employee-master/components/employee-profile-page";
import {
  canEditEmployeePii,
  canCorrectEmployeePtkp,
  canResetPayslipPin,
  canViewEmployees,
} from "@/features/ws10-employee-master/guard";
import { isMockScenarioRequest } from "@/features/ws10-employee-master/lib";
import {
  employeeQuery,
  employeesQuery,
  orgUnitsQuery,
  outletsQuery,
  positionsQuery,
} from "@/features/ws10-employee-master/queries";

// /kelola/karyawan/$employeeId — one employee's profile (PRD v1.7 §3 F24,
// HR-03). Tabs are a search param (`?tab=kontrak|dokumen`), like the inventory
// pages, so each section is linkable and prefetched by the loader.
//
// HR-03 page guard: without `hr.employee.view` the screen renders its locked
// state and the loader requests nothing — never a 404 that hides the reason,
// and never employee or PII data. `canViewEmployees` is the same permission
// check the API applies (`hr.employee.view`).
//
// HR-03: PII-bearing reads (masked PII, contracts with the salary snapshot,
// documents with signed URLs) are never prefetched on the server, so they are
// never serialised into the SSR HTML/dehydrated cache; the browser fetches
// them with the visitor's own session.
export const Route = createFileRoute("/_kelola/kelola/karyawan/$employeeId")({
  validateSearch: z.object({
    tab: z.enum(["kontrak", "dokumen"]).catch("kontrak").default("kontrak"),
  }),
  loader: ({ context, location, params }) => {
    if (!canViewEmployees(context.access)) return undefined;
    // `?mock=empty|slow|…` must reach the browser, not be frozen into SSR.
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(employeeQuery(params.employeeId)),
      // Manager names come from the directory payload.
      context.queryClient.ensureQueryData(employeesQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(orgUnitsQuery()),
      context.queryClient.ensureQueryData(outletsQuery()),
    ]);
  },
  component: ProfileScreen,
});

function ProfileScreen() {
  const { employeeId } = Route.useParams();
  const { tab } = Route.useSearch();
  const { access } = Route.useRouteContext();
  return (
    <EmployeeProfilePage
      employeeId={employeeId}
      tab={tab}
      locked={!canViewEmployees(access)}
      canEditPii={canEditEmployeePii(access)}
      canResetPin={canResetPayslipPin(access)}
      canCorrectPtkp={canCorrectEmployeePtkp(access)}
    />
  );
}
