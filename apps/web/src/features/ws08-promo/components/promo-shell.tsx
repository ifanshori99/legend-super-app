// Shared frame for every promo admin screen: page title, the link tabs between
// sections (each has its own URL, docs/frontend.md "Add a page"), plus the
// small pieces every screen reuses: offline notice, notice box, status pill
// and the multi-select checkbox group.
import * as React from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  FilePen,
  Info,
  PauseCircle,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { PromotionStatus } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Badge, StatusPill, type StatusKind } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/feedback-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { ConflictLevel } from "../lib";
import { usePromoT } from "../t";

const TABS = [
  { key: "promos", labelKey: "tabs.promos", to: "/kelola/promo" },
  {
    key: "stacking",
    labelKey: "tabs.stacking",
    to: "/kelola/promo/tumpang-tindih",
  },
  { key: "vouchers", labelKey: "tabs.vouchers", to: "/kelola/promo/voucher" },
  { key: "roi", labelKey: "tabs.roi", to: "/kelola/promo/roi" },
] as const;

export type PromoSection = (typeof TABS)[number]["key"];

/** Browser connectivity, so screens can say "offline" instead of "error". */
export function useOnline(): boolean {
  return React.useSyncExternalStore(
    (notify) => {
      window.addEventListener("online", notify);
      window.addEventListener("offline", notify);
      return () => {
        window.removeEventListener("online", notify);
        window.removeEventListener("offline", notify);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function PromoTabs({ active }: { active: PromoSection }) {
  const t = usePromoT();
  return (
    <nav
      aria-label={t("promo.title")}
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

export function PromoPage({
  active,
  children,
}: {
  active: PromoSection;
  children: ReactNode;
}) {
  const t = usePromoT();
  const common = useT();
  const online = useOnline();
  return (
    // The management topbar renders the area h1 (DESIGN.md v3 §5); the
    // section keeps its own name as an h2 so it never repeats the topbar.
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-title">{t("promo.title")}</h2>
          {API_MOCK && (
            <Badge tone="neutral">{common("common.sampleData")}</Badge>
          )}
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("promo.subtitle")}
        </p>
      </header>
      <PromoTabs active={active} />
      {!online && (
        <Notice tone="warning" icon={WifiOff} title={t("promo.offline.title")}>
          {t("promo.offline.description")}
        </Notice>
      )}
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}

const NOTICE: Record<ConflictLevel, { box: string; icon: LucideIcon }> = {
  danger: { box: "bg-danger-subtle text-danger", icon: CircleAlert },
  warning: { box: "bg-warning-subtle text-warning", icon: TriangleAlert },
  info: { box: "bg-info-subtle text-info", icon: Info },
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
  tone: ConflictLevel;
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

const STATUS_PILL: Record<
  PromotionStatus,
  { status: StatusKind; icon: LucideIcon }
> = {
  draft: { status: "info", icon: FilePen },
  active: { status: "success", icon: CircleCheck },
  paused: { status: "warning", icon: PauseCircle },
  ended: { status: "delivered", icon: CircleSlash },
};

export function PromoStatusPill({ status }: { status: PromotionStatus }) {
  const t = usePromoT();
  const { status: kind, icon } = STATUS_PILL[status];
  return (
    <StatusPill
      status={kind}
      icon={status === "active" ? undefined : icon}
      className="text-xs"
    >
      {t(`promo.status.${status}`)}
    </StatusPill>
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
  const t = usePromoT();
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
      title={network ? t("promo.offline.readTitle") : undefined}
      description={network ? t("promo.offline.readHint") : undefined}
      onRetry={onRetry}
    />
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  const t = usePromoT();
  return (
    <div aria-busy="true" className="grid gap-3 p-card">
      <span className="sr-only">{t("promo.common.loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-control" />
      ))}
    </div>
  );
}

export type CheckOption = { id: string; label: string };

/** Multi-select as a checkbox group, for menu items, tiers, channels, days. */
export function CheckGroup({
  idPrefix,
  legend,
  hint,
  options,
  value,
  onChange,
  error,
  state = "ready",
  emptyText,
  stateText,
  className,
  columns = true,
}: {
  idPrefix: string;
  legend: string;
  hint?: string;
  options: readonly CheckOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string;
  state?: "ready" | "loading" | "error";
  emptyText?: string;
  /** Message for the loading / error state. */
  stateText?: string;
  className?: string;
  columns?: boolean;
}) {
  const hintId = `${idPrefix}-hint`;
  const errorId = `${idPrefix}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <fieldset
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className={cn("grid gap-2", className)}
    >
      <legend className="text-sm leading-5 font-semibold">{legend}</legend>
      {hint && (
        <p id={hintId} className="text-sm leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      <div
        className={cn(
          "grid max-h-48 gap-2 overflow-y-auto rounded-lg border-(length:--border-w) p-3",
          columns && "sm:grid-cols-2",
        )}
      >
        {state !== "ready" ? (
          <p
            role={state === "error" ? "alert" : "status"}
            className="text-sm text-muted-foreground"
          >
            {stateText}
          </p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          options.map((option) => (
            <div key={option.id} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-${option.id}`}
                checked={value.includes(option.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...value, option.id]
                      : value.filter((candidate) => candidate !== option.id),
                  )
                }
              />
              <Label
                htmlFor={`${idPrefix}-${option.id}`}
                className="min-w-0 truncate font-normal"
              >
                {option.label}
              </Label>
            </div>
          ))
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-sm leading-5 text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
