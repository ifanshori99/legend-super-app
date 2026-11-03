// Shared frame for every CRM back-office screen: page title, the link tabs
// between the sections, and the small pieces every screen reuses (offline
// notice, status pills, read-problem state, cursor pager). Tabs are links, not
// Radix tabs, because each section has its own URL (docs/frontend.md "Add a
// page").
import type { ReactNode } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { cn } from "cn";
import {
  CircleSlash,
  Clock,
  Eye,
  MessageSquareWarning,
  PauseCircle,
  Star,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type {
  FeedbackKind,
  FeedbackStatus,
  MembershipStatus,
} from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { useOnline } from "@/lib/use-online";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { Badge, StatusPill, type StatusKind } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import {
  feedbackKindKey,
  feedbackStatusKey,
  membershipStatusKey,
} from "../lib";
import { useCrm360T } from "../t";

// `anyOf` mirrors each route's beforeLoad guard, so a role that may open only
// the review queue (review.respond) is not shown tabs that lead to notFound.
const TABS = [
  {
    key: "customers",
    labelKey: "crm360.tabs.customers",
    to: "/kelola/pelanggan",
    anyOf: ["crm.customer.view"],
  },
  {
    key: "segments",
    labelKey: "crm360.tabs.segments",
    to: "/kelola/pelanggan/segmen",
    anyOf: ["crm.customer.view"],
  },
  {
    key: "feedback",
    labelKey: "crm360.tabs.feedback",
    to: "/kelola/ulasan",
    anyOf: ["review.respond", "crm.customer.view"],
  },
] as const satisfies readonly {
  key: string;
  labelKey: string;
  to: string;
  anyOf: readonly PermissionCode[];
}[];

export type CrmSection = (typeof TABS)[number]["key"];

export function CrmTabs({ active }: { active: CrmSection }) {
  const t = useCrm360T();
  const { access } = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  const tabs = TABS.filter(
    (tab) => access !== undefined && holdsAny(access, tab.anyOf),
  );
  if (tabs.length < 2) return null;
  return (
    <nav
      aria-label={t("crm360.title")}
      className={cn(tabsListClass, "[scrollbar-width:none]")}
    >
      {tabs.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // Exact match only: the customers link must not keep its own
            // aria-current on the segment or feedback section.
            activeOptions={{ exact: true }}
            // On 390px the strip scrolls; keep the current tab in view.
            ref={
              current
                ? (node: HTMLAnchorElement | null) =>
                    node?.scrollIntoView?.({
                      block: "nearest",
                      inline: "nearest",
                    })
                : undefined
            }
            aria-current={current ? "page" : undefined}
            className={tabsTriggerClass}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function CrmPage({
  active,
  children,
}: {
  active: CrmSection;
  children: ReactNode;
}) {
  const t = useCrm360T();
  const common = useT();
  const online = useOnline();
  return (
    // The management topbar renders the area h1 (DESIGN.md v3 §5); the
    // section keeps its own name as an h2 so it never repeats the topbar.
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">{t("crm360.title")}</h2>
          {API_MOCK && (
            <Badge tone="neutral">{common("common.sampleData")}</Badge>
          )}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("crm360.subtitle")}
        </p>
      </header>
      <CrmTabs active={active} />
      {!online && (
        <Notice tone="warning" icon={WifiOff} title={t("crm360.offline.title")}>
          {t("crm360.offline.description")}
        </Notice>
      )}
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}

const NOTICE_TONE = {
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
} as const;

/** A tinted message box: icon + text, never color alone (WCAG 1.4.1). */
export function Notice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof NOTICE_TONE;
  icon: LucideIcon;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-control px-3 py-2.5 text-sm leading-5",
        NOTICE_TONE[tone],
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid min-w-0 gap-0.5">
        {title && <p className="font-semibold">{title}</p>}
        <div className="min-w-0 break-words">{children}</div>
      </div>
    </div>
  );
}

const MEMBERSHIP: Record<
  MembershipStatus,
  { status: StatusKind; icon?: LucideIcon }
> = {
  pending_verification: { status: "warning", icon: Clock },
  active: { status: "success" },
  suspended: { status: "danger", icon: PauseCircle },
  closed: { status: "delivered", icon: CircleSlash },
};

export function MembershipStatusPill({ status }: { status: MembershipStatus }) {
  const t = useCrm360T();
  const { status: kind, icon } = MEMBERSHIP[status];
  return (
    <StatusPill status={kind} icon={icon} className="text-xs">
      {t(membershipStatusKey(status))}
    </StatusPill>
  );
}

const FEEDBACK_STATUS: Record<
  FeedbackStatus,
  { status: StatusKind; icon?: LucideIcon }
> = {
  open: { status: "warning", icon: Clock },
  in_review: { status: "info", icon: Eye },
  resolved: { status: "success" },
  closed: { status: "delivered", icon: CircleSlash },
};

export function FeedbackStatusPill({ status }: { status: FeedbackStatus }) {
  const t = useCrm360T();
  const { status: kind, icon } = FEEDBACK_STATUS[status];
  return (
    <StatusPill status={kind} icon={icon} className="text-xs">
      {t(feedbackStatusKey(status))}
    </StatusPill>
  );
}

export function FeedbackKindBadge({ kind }: { kind: FeedbackKind }) {
  const t = useCrm360T();
  return (
    <Badge tone={kind === "complaint" ? "warning" : "brand"}>
      {kind === "complaint" ? (
        <MessageSquareWarning aria-hidden="true" />
      ) : (
        <Star aria-hidden="true" />
      )}
      {t(feedbackKindKey(kind))}
    </Badge>
  );
}

function isOffline(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.code === "NETWORK_ERROR")
  );
}

/**
 * Failed read. A dropped connection says "offline" and how to fix it; any
 * other failure keeps the endpoint-specific copy. Both offer a retry.
 */
export function ReadProblem({
  error,
  title,
  hint,
  offlineTitle,
  offlineHint,
  onRetry,
}: {
  error: unknown;
  title: string;
  hint: string;
  offlineTitle: string;
  offlineHint: string;
  onRetry?: () => void;
}) {
  const offline = isOffline(error);
  return (
    <ErrorState
      icon={offline ? WifiOff : undefined}
      title={offline ? offlineTitle : title}
      description={offline ? offlineHint : hint}
      onRetry={onRetry}
    />
  );
}

/**
 * Cursor pager for the list footers. Cursor pages carry no total, so the
 * footer states the loaded row count and offers previous/next.
 */
export function CursorPager({
  countLabel,
  canPrevious,
  canNext,
  pending,
  onPrevious,
  onNext,
}: {
  countLabel: string;
  canPrevious: boolean;
  canNext: boolean;
  pending: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const t = useT();
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-card py-2 text-sm text-muted-foreground">
      <span className="tabular">{countLabel}</span>
      <nav className="flex flex-wrap gap-2" aria-label={countLabel}>
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrevious || pending}
          onClick={onPrevious}
        >
          {t("common.previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canNext || pending}
          onClick={onNext}
        >
          {t("common.next")}
        </Button>
      </nav>
    </footer>
  );
}
