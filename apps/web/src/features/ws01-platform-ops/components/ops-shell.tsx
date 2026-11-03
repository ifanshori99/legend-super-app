// Shared frame pieces for the platform ops screens: page wrapper with the
// "Contoh data" badge in mock mode, a titled section card (v3 double shell),
// the tenant picker, and the usage bar used by quotas and cost caps.
import * as React from "react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenants } from "../hooks";
import type { BarState } from "../logic";

export function OpsPage({
  children,
  toolbar,
}: {
  children: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      {(toolbar || API_MOCK) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
      )}
      {children}
    </div>
  );
}

/** One titled region: outer shell + inner card with a header row. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const headingId = React.useId();
  return (
    <CardShell role="region" aria-labelledby={headingId} className={className}>
      <CardShellBody>
        <header className="flex flex-col gap-2 border-b p-card sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 id={headingId} className="type-title">
              {title}
            </h2>
            {description && (
              <p className="text-sm leading-5 text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions}
        </header>
        <div className={cn("min-w-0 p-card", bodyClassName)}>{children}</div>
      </CardShellBody>
    </CardShell>
  );
}

/** Skeleton rows while a section loads. */
export function SectionLoading({ rows = 4 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="grid gap-2" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-row" />
      ))}
    </div>
  );
}

export function SectionError({ onRetry }: { onRetry: () => void }) {
  return <ErrorState onRetry={onRetry} className="py-6" />;
}

/**
 * Tenant chosen on a screen. Defaults to the first tenant in the registry;
 * `tenantId` is null while the list loads or when it is empty.
 */
export function useSelectedTenant() {
  const tenants = useTenants();
  const [picked, setPicked] = React.useState<string | null>(null);
  const rows = tenants.data?.data ?? [];
  const tenantId =
    picked !== null && rows.some((row) => row.id === picked)
      ? picked
      : (rows[0]?.id ?? null);
  return { tenants, rows, tenantId, setTenantId: setPicked };
}

export function TenantPicker({
  rows,
  value,
  onChange,
}: {
  rows: readonly { id: string; name: string }[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        className="h-control-sm sm:w-64"
        aria-label={t("platformOps.tenantPicker")}
      >
        <SelectValue placeholder={t("platformOps.tenantPicker")} />
      </SelectTrigger>
      <SelectContent>
        {rows.map((row) => (
          <SelectItem key={row.id} value={row.id}>
            {row.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const FILL: Record<BarState, string> = {
  ok: "bg-primary",
  warning: "bg-warning",
  stopped: "bg-danger",
};

/**
 * Usage against a limit (quota or monthly cost cap). The state is always
 * written in words next to the bar, never colour alone (WCAG 1.4.1).
 */
export function UsageBar({
  label,
  detail,
  percent,
  state,
  stateLabel,
  off = false,
  note,
}: {
  label: string;
  detail: React.ReactNode;
  percent: number;
  state: BarState;
  stateLabel: string;
  /** The limit is 0 on purpose (feature off): a neutral label, no alarm. */
  off?: boolean;
  note?: string;
}) {
  const status =
    state === "ok" ? "success" : state === "warning" ? "warning" : "danger";
  return (
    <div className="grid gap-1.5" data-state={off ? "off" : state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">{label}</p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground tabular">
          {detail}
          {off ? (
            <Badge tone="neutral">{stateLabel}</Badge>
          ) : (
            <StatusPill status={status} className="text-xs">
              {stateLabel}
            </StatusPill>
          )}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cn("h-full rounded-full", FILL[state])}
          style={{ width: `${percent}%` }}
        />
      </div>
      {note && (
        <p className="text-xs leading-4 text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
