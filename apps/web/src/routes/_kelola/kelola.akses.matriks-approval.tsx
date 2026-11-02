import { createFileRoute } from "@tanstack/react-router";
import { ApprovalMatrixPage } from "@/features/ws01-access/components/approval-matrix-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { isMockScenarioRequest } from "@/features/ws01-access/lib";
import {
  approvalMatrixQuery,
  rolesQuery,
} from "@/features/ws01-access/queries";

// /kelola/akses/matriks-approval — approval matrix (PRD §3 F7, AUTH-06).
export const Route = createFileRoute("/_kelola/kelola/akses/matriks-approval")({
  beforeLoad: accessGuard([
    "access.approval_policy.manage",
    "access.role.view",
  ]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(approvalMatrixQuery()),
          context.queryClient.ensureQueryData(rolesQuery()),
        ]),
  component: MatrixScreen,
});

function MatrixScreen() {
  const { access } = Route.useRouteContext();
  return <ApprovalMatrixPage access={access} />;
}
