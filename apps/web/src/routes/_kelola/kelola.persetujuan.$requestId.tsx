import { createFileRoute } from "@tanstack/react-router";
import { ApprovalDetailPage } from "@/features/ws01-approvals/components/approval-detail";
import { approvalGuard } from "@/features/ws01-approvals/guard";

// /kelola/persetujuan/<requestId> — deep link to one request.
export const Route = createFileRoute("/_kelola/kelola/persetujuan/$requestId")({
  beforeLoad: approvalGuard,
  component: DetailScreen,
});

function DetailScreen() {
  const { access } = Route.useRouteContext();
  const { requestId } = Route.useParams();
  return <ApprovalDetailPage requestId={requestId} access={access} />;
}
