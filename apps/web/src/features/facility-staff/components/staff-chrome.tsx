// Shared chrome for the four staff facility screens: the page heading, the
// link sub-navigation (the operations shell has no nav chrome, so the page owns
// its section links), the offline notice and the loading/error/empty panels
// every screen needs (DESIGN.md §4 "Operations — status hierarchy").
import * as React from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import { WifiOff } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { useOnline } from "@/lib/use-online";
import type { StaffScreenKey } from "../view.ts";

export function StaffPageHeader({
  titleKey,
  hintKey,
  facilityName,
  actions,
}: {
  titleKey: MessageKey;
  hintKey: MessageKey;
  facilityName?: string;
  actions?: React.ReactNode;
}) {
  const t = useT();
  return (
    <header
      data-slot="facility-staff-header"
      className="flex flex-wrap items-start justify-between gap-3"
    >
      <div className="grid min-w-0 gap-1">
        <h1 className="type-display">{t(titleKey)}</h1>
        <p className="text-sm leading-5 text-muted-foreground">{t(hintKey)}</p>
        {facilityName && (
          <p className="text-sm font-semibold">{facilityName}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

// A 2x2 grid below `sm` so every tab, "Darurat" last, stays whole at 390 px,
// 320 px and 200% zoom ("Kebersihan" cannot wrap; legend-jztb7). Each tab is
// at least 44 px tall below `sm` (touch target, founder Q32).
const SUBNAV_TRIGGER = cn(
  tabsTriggerClass,
  "min-h-11 w-full justify-center px-1.5 text-center leading-tight whitespace-normal sm:min-h-[calc(var(--control-h-sm)-0.5rem)] sm:w-auto sm:px-3.5 sm:whitespace-nowrap",
);

// Explicit links instead of a data array: each `to` stays a literal so the
// router's generated route types check every path and its search shape.
export function StaffSubNav({
  current,
  facilityId,
}: {
  current: StaffScreenKey;
  facilityId?: string;
}) {
  const t = useT();
  const link = (key: StaffScreenKey) => (current === key ? "page" : undefined);
  return (
    <nav aria-label={t("facilityStaff.subnav.label")}>
      <ul
        data-slot="facility-staff-subnav"
        className={cn(
          tabsListClass,
          "grid w-full list-none grid-cols-2 sm:inline-flex sm:w-fit",
        )}
      >
        <li>
          <Link
            to="/fasilitas"
            search={{ facilityId }}
            aria-current={link("board")}
            className={SUBNAV_TRIGGER}
          >
            {t("facilityStaff.subnav.board")}
          </Link>
        </li>
        <li>
          <Link
            to="/fasilitas/kebersihan"
            search={{ facilityId }}
            aria-current={link("cleaning")}
            className={SUBNAV_TRIGGER}
          >
            {t("facilityStaff.subnav.cleaning")}
          </Link>
        </li>
        <li>
          <Link
            to="/fasilitas/insiden"
            search={{ facilityId }}
            aria-current={link("incidents")}
            className={SUBNAV_TRIGGER}
          >
            {t("facilityStaff.subnav.incidents")}
          </Link>
        </li>
        <li>
          <Link
            to="/fasilitas/darurat"
            search={{ facilityId }}
            aria-current={link("emergency")}
            className={SUBNAV_TRIGGER}
          >
            {t("facilityStaff.subnav.emergency")}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

export function OfflineNotice({
  hintKey = "facilityStaff.common.offlineHint",
}: {
  hintKey?: MessageKey;
}) {
  const t = useT();
  const online = useOnline();
  if (online) return null;
  return (
    <div
      data-slot="offline-notice"
      role="status"
      className="flex items-start gap-2 rounded-container border-(length:--border-w) border-dashed border-warning bg-warning-subtle p-3 text-sm text-warning"
    >
      <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-0.5">
        <p className="font-semibold">
          {t("facilityStaff.common.offlineTitle")}
        </p>
        <p className="font-normal">{t(hintKey)}</p>
      </div>
    </div>
  );
}

export function StaffLoading({ labelKey }: { labelKey: MessageKey }) {
  const t = useT();
  return (
    <Card aria-busy="true" data-slot="facility-staff-loading">
      <span role="status" className="sr-only">
        {t(labelKey)}
      </span>
      <Skeleton className="h-6 w-56" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-40 w-full rounded-container" />
        ))}
      </div>
    </Card>
  );
}

export function StaffError({
  titleKey,
  hintKey,
  onRetry,
  error,
}: {
  titleKey: MessageKey;
  hintKey: MessageKey;
  onRetry: () => void;
  error?: unknown;
}) {
  const t = useT();
  return (
    <Card data-slot="facility-staff-error">
      <ErrorState
        error={error}
        title={t(titleKey)}
        description={t(hintKey)}
        onRetry={onRetry}
      />
    </Card>
  );
}

export function StaffEmpty({
  titleKey,
  hintKey,
  icon,
  action,
}: {
  titleKey: MessageKey;
  hintKey: MessageKey;
  icon?: LucideIcon;
  action?: React.ReactNode;
}) {
  const t = useT();
  return (
    <Card data-slot="facility-staff-empty">
      <EmptyState
        title={t(titleKey)}
        description={t(hintKey)}
        icon={icon}
        action={action}
      />
    </Card>
  );
}
