// In-app notice for failed items (PRD §3 F10, ORD-08). Shown by the layout on
// every screen while at least one issue waits for the guest's choice. It never
// blocks the page: nothing renders while loading or on error.
import { Link, useLocation } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useTableJourney } from "@/features/ws03-qr-order/context";
import { useOrderIssues } from "@/features/ws03-qr-order/hooks";
import { isIssueActionable } from "@/features/ws03-qr-order/domain";

export function IssuePrompt() {
  const t = useT();
  const { qrToken, sessionId } = useTableJourney();
  const issues = useOrderIssues(sessionId);
  const { pathname } = useLocation();

  const open = (issues.data?.data ?? []).filter(isIssueActionable);
  const first = open[0];
  // The choice screen itself already says it; do not repeat the banner there.
  if (!first || pathname.includes("/issue/")) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-xl border-(length:--border-w) border-warning bg-warning-subtle p-3"
    >
      <TriangleAlert
        className="size-icon shrink-0 text-warning"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-sm leading-5 font-medium text-foreground">
        {open.length === 1
          ? t("qrRecovery.prompt.one", { item: first.itemName })
          : t("qrRecovery.prompt.many", { count: open.length })}
      </p>
      <Button asChild size="sm">
        <Link
          to="/t/$token/issue/$issueId"
          params={{ token: qrToken, issueId: first.id }}
        >
          {t("qrRecovery.prompt.action")}
        </Link>
      </Button>
    </div>
  );
}
