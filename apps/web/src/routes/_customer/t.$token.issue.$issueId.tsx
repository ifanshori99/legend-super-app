import { createFileRoute } from "@tanstack/react-router";
import { IssuePage } from "@/features/ws03-qr-order/components/recovery";

// "/t/[token]/issue/[issueId]" — failed item recovery (PRD §3 F10, ORD-08).
export const Route = createFileRoute("/_customer/t/$token/issue/$issueId")({
  component: IssueRoute,
});

function IssueRoute() {
  const { issueId } = Route.useParams();
  return <IssuePage issueId={issueId} />;
}
