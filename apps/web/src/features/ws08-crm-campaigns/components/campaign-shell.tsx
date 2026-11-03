// Shared frame for the campaign screens: page title, the link tabs between
// sections (each has its own URL, docs/frontend.md "Add a page"), the offline
// notice, and the small pieces every screen reuses (notice box, read error).
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CircleAlert,
  Info,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/feedback-state";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOnline } from "@/lib/use-online";

const TABS = [
  {
    key: "campaigns",
    labelKey: "crmCampaigns.tabs.campaigns",
    to: "/kelola/kampanye",
  },
  {
    key: "automations",
    labelKey: "crmCampaigns.tabs.automations",
    to: "/kelola/kampanye/otomasi",
  },
] as const;

export type CampaignSection = (typeof TABS)[number]["key"];

export function CampaignTabs({ active }: { active: CampaignSection }) {
  const t = useT();
  return (
    <nav
      aria-label={t("crmCampaigns.title")}
      className={cn(tabsListClass, "[scrollbar-width:none]")}
    >
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            // Exact match only: a parent link must not keep its own
            // aria-current on a child section (two current tabs).
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

export function CampaignsPage({
  active,
  children,
}: {
  active: CampaignSection;
  children: ReactNode;
}) {
  const t = useT();
  const online = useOnline();
  return (
    // The management topbar renders the area h1 (DESIGN.md v3 §5); the
    // section keeps its own name as an h2 so it never repeats the topbar.
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">{t("crmCampaigns.title")}</h2>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("crmCampaigns.subtitle")}
        </p>
      </header>
      <CampaignTabs active={active} />
      {!online && (
        <Notice
          tone="warning"
          icon={WifiOff}
          title={t("crmCampaigns.errors.offline")}
        >
          {t("crmCampaigns.errors.offlineHint")}
        </Notice>
      )}
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}

const NOTICE: Record<
  "info" | "warning" | "danger",
  { box: string; icon: LucideIcon }
> = {
  info: { box: "bg-info-subtle text-info", icon: Info },
  warning: { box: "bg-warning-subtle text-warning", icon: TriangleAlert },
  danger: { box: "bg-danger-subtle text-danger", icon: CircleAlert },
};

/** A tinted message box: icon + text, never color alone (WCAG 1.4.1). */
export function Notice({
  tone,
  icon,
  title,
  children,
  className,
  role,
}: {
  tone: "info" | "warning" | "danger";
  icon?: LucideIcon;
  title?: string;
  children: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  const Icon = icon ?? NOTICE[tone].icon;
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-2.5 rounded-control px-3 py-2.5 text-sm leading-5",
        NOTICE[tone].box,
        className,
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

/**
 * Failed read. A dropped connection says "offline" and how to fix it; any
 * other failure keeps the generic message. Both offer a retry.
 */
export function ReadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  const online = useOnline();
  const network =
    !online ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "NETWORK_ERROR");
  return (
    <ErrorState
      icon={network ? WifiOff : undefined}
      title={network ? t("crmCampaigns.errors.offline") : undefined}
      description={network ? t("crmCampaigns.errors.offlineHint") : undefined}
      onRetry={onRetry}
    />
  );
}
