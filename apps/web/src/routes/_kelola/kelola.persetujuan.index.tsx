import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInboxPage } from "@/features/ws01-approvals/components/inbox-page";
import { approvalGuard } from "@/features/ws01-approvals/guard";

// /kelola/persetujuan — unified approval inbox (PRD §3 F7 Kotak Approval).
export const Route = createFileRoute("/_kelola/kelola/persetujuan/")({
  beforeLoad: approvalGuard,
  component: InboxScreen,
});

function InboxScreen() {
  const { access } = Route.useRouteContext();
  return <ApprovalInboxPage access={access} />;
}
