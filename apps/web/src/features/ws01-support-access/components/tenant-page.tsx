// /kelola/akses-dukungan: the tenant admin sees every support session on
// their tenant and a notice while one is running (PRD v1.7 §3 F4; TEN-04
// "terlihat oleh admin tenant").
import * as React from "react";
import { LifeBuoy, ShieldCheck } from "lucide-react";
import type { SupportAccessGrant } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOrgGrants } from "../hooks.ts";
import {
  clockSkewMs,
  findActiveGrant,
  sortGrantsNewestFirst,
} from "../logic.ts";
import { useSecondClock } from "../use-now.ts";
import {
  Countdown,
  formatInstant,
  GrantStatusBadge,
  ModeBadge,
  useGrantStatus,
} from "./shared.tsx";

function HistoryRow({
  grant,
  skewMs,
}: {
  grant: SupportAccessGrant;
  skewMs: number;
}) {
  const t = useT();
  const status = useGrantStatus(grant, skewMs);
  return (
    <TableRow>
      <TableCell className="max-w-sm">
        <span className="grid gap-0.5">
          <span className="line-clamp-3 text-sm">{grant.reason}</span>
          <span className="text-xs text-muted-foreground md:hidden">
            {formatInstant(grant.startedAt)}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <ModeBadge mode={grant.accessMode} />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="grid gap-0.5 text-sm">
          <span>{formatInstant(grant.startedAt)}</span>
          <span className="text-muted-foreground">
            {t("supportAccess.tenant.duration", {
              minutes: grant.durationMinutes,
            })}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span className="text-sm text-muted-foreground">
          {grant.tenantAdminNotifiedAt
            ? t("supportAccess.tenant.notified", {
                time: formatInstant(grant.tenantAdminNotifiedAt),
              })
            : t("supportAccess.tenant.notNotified")}
        </span>
      </TableCell>
      <TableCell>
        <GrantStatusBadge status={status} />
      </TableCell>
    </TableRow>
  );
}

function ActiveNotice({
  grant,
  skewMs,
}: {
  grant: SupportAccessGrant;
  skewMs: number;
}) {
  const t = useT();
  return (
    <Card
      role="status"
      className="gap-2 border-warning bg-warning-subtle text-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-base font-semibold">
          <LifeBuoy className="size-icon text-warning" aria-hidden="true" />
          {t("supportAccess.tenant.notice")}
        </p>
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <ModeBadge mode={grant.accessMode} />
          <Countdown grant={grant} skewMs={skewMs} />
        </span>
      </div>
      <p className="text-sm">
        {t("supportAccess.tenant.noticeBody", {
          reason: grant.reason,
          time: formatInstant(grant.expiresAt),
        })}
      </p>
    </Card>
  );
}

export function TenantSupportAccessPage() {
  const t = useT();
  const grants = useOrgGrants();
  const clockMs = useSecondClock();
  // Shift the device clock to the API clock (see session-banner).
  const skewMs = clockSkewMs(grants.data?.serverNow, grants.dataUpdatedAt);
  const nowMs = clockMs === null ? null : clockMs + skewMs;

  const rows = React.useMemo(
    () => sortGrantsNewestFirst(grants.data?.data ?? []),
    [grants.data],
  );
  const active = nowMs === null ? null : findActiveGrant(rows, nowMs);

  const state = grants.isPending
    ? "loading"
    : grants.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {t("supportAccess.tenant.description")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      {state === "ready" &&
        (active ? (
          <ActiveNotice grant={active} skewMs={skewMs} />
        ) : (
          <Card className="flex-row items-start gap-3">
            <ShieldCheck
              className="mt-0.5 size-icon shrink-0 text-success"
              aria-hidden="true"
            />
            <div className="grid gap-1">
              <p className="text-sm font-semibold">
                {t("supportAccess.tenant.noActive")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("supportAccess.tenant.noActiveBody")}
              </p>
            </div>
          </Card>
        ))}

      <DataTableShell
        title={t("supportAccess.tenant.listTitle")}
        description={t("supportAccess.tenant.listDescription")}
        state={state}
        onRetry={() => void grants.refetch()}
        empty={{
          title: t("supportAccess.tenant.emptyTitle"),
          description: t("supportAccess.tenant.emptyHint"),
        }}
        rowCount={rows.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("supportAccess.tenant.columnReason")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("supportAccess.tenant.columnScope")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("supportAccess.tenant.columnWindow")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                {t("supportAccess.tenant.columnNotified")}
              </TableHead>
              <TableHead>{t("supportAccess.tenant.columnStatus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((grant) => (
              <HistoryRow key={grant.id} grant={grant} skewMs={skewMs} />
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
