// /platform/akses-dukungan: Super Admin requests, lists and ends support
// sessions (PRD v1.7 §3 F4 "Support Access"; TEN-04).
import * as React from "react";
import { Info, Plus, Power } from "lucide-react";
import type { SupportAccessGrant } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/components/ui/toast";
import { API_MOCK } from "@/lib/api/mock-flag";
import { supportErrorMessage } from "../errors.ts";
import {
  useEndSupportAccess,
  usePlatformGrants,
  useTenants,
} from "../hooks.ts";
import { clockSkewMs, sortGrantsNewestFirst } from "../logic.ts";
import { RequestSupportAccessDialog } from "./request-dialog.tsx";
import {
  Countdown,
  formatInstant,
  GrantStatusBadge,
  ModeBadge,
  useGrantStatus,
} from "./shared.tsx";

function GrantRow({
  grant,
  tenantName,
  canEnd,
  ending,
  skewMs,
  onEnd,
}: {
  grant: SupportAccessGrant;
  tenantName: string;
  canEnd: boolean;
  ending: boolean;
  skewMs: number;
  onEnd: (grant: SupportAccessGrant) => void;
}) {
  const t = useT();
  const status = useGrantStatus(grant, skewMs);
  return (
    <TableRow>
      <TableCell>
        <span className="grid gap-0.5">
          <span className="font-semibold">{tenantName}</span>
          <span className="text-xs text-muted-foreground lg:hidden">
            {formatInstant(grant.startedAt)}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden max-w-xs md:table-cell">
        <span className="line-clamp-2 text-sm">{grant.reason}</span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <ModeBadge mode={grant.accessMode} />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span className="grid gap-0.5 text-sm">
          <span>{formatInstant(grant.startedAt)}</span>
          <span className="text-muted-foreground">
            {status === "active" ? (
              <>
                {t("supportAccess.platform.remaining", { time: "" })}
                <Countdown grant={grant} skewMs={skewMs} />
              </>
            ) : grant.endedAt ? (
              t("supportAccess.platform.endedAt", {
                time: formatInstant(grant.endedAt),
              })
            ) : (
              t("supportAccess.platform.expiresAt", {
                time: formatInstant(grant.expiresAt),
              })
            )}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <GrantStatusBadge status={status} />
      </TableCell>
      <TableCell>
        {canEnd && status === "active" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={ending}
            aria-label={t("supportAccess.platform.endLabel", {
              tenant: tenantName,
            })}
            onClick={() => onEnd(grant)}
          >
            <Power aria-hidden="true" />
            {t("supportAccess.platform.endNow")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export function PlatformSupportAccessPage() {
  const t = useT();
  const toast = useToast();
  const grants = usePlatformGrants();
  // Shift the device clock to the API clock (see session-banner).
  const skewMs = clockSkewMs(grants.data?.serverNow, grants.dataUpdatedAt);
  const tenants = useTenants(true);
  const end = useEndSupportAccess();
  const [search, setSearch] = React.useState("");
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [endingId, setEndingId] = React.useState<string | null>(null);
  const [endError, setEndError] = React.useState<string | null>(null);

  const tenantList = React.useMemo(
    () => tenants.data?.data ?? [],
    [tenants.data],
  );
  const nameOf = React.useCallback(
    (id: string) =>
      tenantList.find((row) => row.id === id)?.name ??
      t("supportAccess.platform.unknownTenant", { id: id.slice(0, 8) }),
    [tenantList, t],
  );

  const rows = React.useMemo(
    () => sortGrantsNewestFirst(grants.data?.data ?? []),
    [grants.data],
  );
  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        nameOf(row.tenantId).toLowerCase().includes(needle) ||
        row.reason.toLowerCase().includes(needle),
    );
  }, [rows, search, nameOf]);

  const state = grants.isPending
    ? "loading"
    : grants.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  const endNow = (grant: SupportAccessGrant) => {
    setEndingId(grant.id);
    setEndError(null);
    end.mutate(grant.id, {
      onSuccess: () => toast({ title: t("supportAccess.platform.ended") }),
      onError: (failure) => setEndError(supportErrorMessage(failure, t)),
      onSettled: () => setEndingId(null),
    });
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        <Button type="button" onClick={() => setRequestOpen(true)}>
          <Plus aria-hidden="true" />
          {t("supportAccess.platform.request")}
        </Button>
      </div>

      <Card className="flex-row items-start gap-3">
        <Info
          className="mt-0.5 size-icon shrink-0 text-info"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">
          {t("supportAccess.platform.description")}
        </p>
      </Card>

      {endError && (
        <p className="text-sm text-danger" role="alert">
          {endError}
        </p>
      )}

      <DataTableShell
        title={t("supportAccess.platform.listTitle")}
        description={t("supportAccess.platform.listDescription")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("supportAccess.platform.search"),
        }}
        noResults={state === "ready" && filtered.length === 0}
        onRetry={() => void grants.refetch()}
        empty={{
          title: t("supportAccess.platform.emptyTitle"),
          description: t("supportAccess.platform.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRequestOpen(true)}
            >
              <Plus aria-hidden="true" />
              {t("supportAccess.platform.request")}
            </Button>
          ),
        }}
        rowCount={filtered.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("supportAccess.platform.columnTenant")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("supportAccess.platform.columnReason")}
              </TableHead>
              <TableHead className="hidden md:table-cell">
                {t("supportAccess.platform.columnScope")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                {t("supportAccess.platform.columnWindow")}
              </TableHead>
              <TableHead>{t("supportAccess.platform.columnStatus")}</TableHead>
              <TableHead className="w-40">
                <span className="sr-only">
                  {t("supportAccess.platform.columnActions")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                tenantName={nameOf(grant.tenantId)}
                canEnd
                ending={endingId === grant.id}
                skewMs={skewMs}
                onEnd={endNow}
              />
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      <RequestSupportAccessDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        tenants={tenantList}
        tenantsState={
          tenants.isPending ? "loading" : tenants.isError ? "error" : "ready"
        }
      />
    </div>
  );
}
