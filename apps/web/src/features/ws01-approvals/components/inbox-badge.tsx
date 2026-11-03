// Notification badge for the shell (PRD §3 F7 Kotak Approval): a link to the
// inbox with the number of requests waiting. The lead mounts it in the
// management shell topbar. It renders nothing when the visitor cannot read the
// inbox (the API says no) so it never shows a broken count.
import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { useT } from "@/components/i18n";
import { useApprovalBadge } from "../hooks";
import { badgeCount } from "../logic.ts";

export function ApprovalInboxBadge({
  enabled = true,
  className,
}: {
  /** Pass false (e.g. no `approval.inbox.view`) to skip the request. */
  enabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const query = useApprovalBadge(enabled);
  if (!enabled || query.isError) return null;
  const { count, capped } = badgeCount(
    query.data?.data ?? [],
    query.data?.meta.nextCursor != null,
  );
  const text = capped ? `${count}+` : String(count);
  return (
    <Link
      to="/kelola/persetujuan"
      data-testid="approval-inbox-badge"
      aria-label={
        count === 0
          ? t("approvals.badge.none")
          : t("approvals.badge.waiting", { count: text })
      }
      className={`relative inline-flex size-11 items-center justify-center rounded-control text-foreground hover:bg-accent ${className ?? ""}`}
    >
      <Inbox className="size-icon" aria-hidden="true" />
      {count > 0 && (
        <span className="absolute top-1 right-1 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-xs leading-5 font-semibold text-danger-foreground tabular">
          {text}
        </span>
      )}
    </Link>
  );
}
