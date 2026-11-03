import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { employeeStatusSchema } from "@starter/shared/hris";
import { EmployeeDirectoryPage } from "@/features/ws10-employee-master/components/employee-directory-page";
import {
  EMPLOYEE_MASTER_PERMISSIONS,
  employeeMasterGuard,
} from "@/features/ws10-employee-master/guard";
import { isMockScenarioRequest } from "@/features/ws10-employee-master/lib";
import {
  contractsQuery,
  employeesQuery,
  orgUnitsQuery,
  outletsQuery,
  positionsQuery,
} from "@/features/ws10-employee-master/queries";

// /kelola/karyawan — employee directory (PRD v1.7 §3 F24 "Data Karyawan &
// Organisasi"). The status/outlet filters live in the URL so the metric tiles
// can link to their own rows.
export const Route = createFileRoute("/_kelola/kelola/karyawan/")({
  validateSearch: z.object({
    status: employeeStatusSchema.optional().catch(undefined),
    outlet: z.string().max(64).optional().catch(undefined),
  }),
  beforeLoad: employeeMasterGuard(EMPLOYEE_MASTER_PERMISSIONS),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(employeesQuery()),
          context.queryClient.ensureQueryData(positionsQuery()),
          context.queryClient.ensureQueryData(orgUnitsQuery()),
          context.queryClient.ensureQueryData(contractsQuery()),
          context.queryClient.ensureQueryData(outletsQuery()),
        ]),
  component: DirectoryScreen,
});

function DirectoryScreen() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <EmployeeDirectoryPage
      status={search.status}
      outletId={search.outlet}
      onFilterChange={(next) => {
        void navigate({
          search: () => ({ status: next.status, outlet: next.outletId }),
          replace: true,
        });
      }}
    />
  );
}
