import { createFileRoute } from "@tanstack/react-router";
import { OrganizationStructurePage } from "@/features/ws10-employee-master/components/organization-page";
import {
  EMPLOYEE_MASTER_PERMISSIONS,
  employeeMasterGuard,
} from "@/features/ws10-employee-master/guard";
import { isMockScenarioRequest } from "@/features/ws10-employee-master/lib";
import {
  employeesQuery,
  orgUnitsQuery,
  positionGradesQuery,
  positionsQuery,
} from "@/features/ws10-employee-master/queries";

// /kelola/organisasi — organisation chart and position catalogue (PRD v1.7 §3
// F24 "Struktur Organisasi"). No org-structure endpoint exists, so the screen
// composes units, positions, grades and headcount from their own lists.
export const Route = createFileRoute("/_kelola/kelola/organisasi")({
  beforeLoad: employeeMasterGuard(EMPLOYEE_MASTER_PERMISSIONS),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(orgUnitsQuery()),
          context.queryClient.ensureQueryData(positionsQuery()),
          context.queryClient.ensureQueryData(positionGradesQuery()),
          context.queryClient.ensureQueryData(employeesQuery()),
        ]),
  component: OrganizationStructurePage,
});
