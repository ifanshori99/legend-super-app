// /kelola/sop — the versioned SOP library (PRD v1.7 §3 F32 "Pustaka SOP",
// F29 read confirmation). Every version keeps its own row and body; a new
// version supersedes the previous one, and a confirmation only counts for the
// exact version the employee read.
//
// The contract exposes confirmation writes but no list read, so the counts and
// "my status" come from the mock read model; a successful acknowledgement is
// layered on top immediately and the screen says when the API cannot answer.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@starter/shared/i18n";
import type { SopDocument } from "@starter/shared/hris";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  useAcknowledgeSop,
  useMyProfile,
  usePositions,
  useSopDocuments,
} from "../hooks";
import {
  acknowledgementCount,
  formatBusinessDate,
  formatDateTime,
  groupSopDocuments,
  hasAcknowledged,
  latestSopVersion,
} from "../lib";
import {
  fixtureSopAcknowledgements,
  recordSopAcknowledgement,
} from "../read-model";

export function SopPage() {
  const t = useT();
  const toast = useToast();
  const documentsQuery = useSopDocuments();
  const positionsQuery = usePositions();
  const profileQuery = useMyProfile();
  const acknowledge = useAcknowledgeSop();
  const acknowledgements = fixtureSopAcknowledgements();
  const [selected, setSelected] = React.useState<SopDocument | null>(null);
  // Versions confirmed in this visit: without a list endpoint (real API) the
  // read model cannot reflect the write, so the button must still go away.
  const [confirmedHere, setConfirmedHere] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const employeeId = profileQuery.data?.employee.id;
  const positionsById = React.useMemo(
    () =>
      new Map(
        (positionsQuery.data?.data ?? []).map((position) => [
          position.id,
          position,
        ]),
      ),
    [positionsQuery.data],
  );
  const documents = React.useMemo(
    () => documentsQuery.data?.data ?? [],
    [documentsQuery.data],
  );
  const groups = React.useMemo(() => groupSopDocuments(documents), [documents]);

  const scopeName = (document: Pick<SopDocument, "positionId">) => {
    if (document.positionId === null)
      return t("learning.sop.scopeAllPositions");
    const position = positionsById.get(document.positionId);
    return position?.name ?? t("learning.sop.scopeAllPositions");
  };

  // The version in force per document family: only it can be confirmed (an
  // older version is history; F29 asks for the version that applies).
  const latestById = React.useMemo(() => {
    const map = new Map<string, SopDocument>();
    for (const group of groups) {
      const latest = latestSopVersion(group);
      for (const version of group.versions) map.set(version.id, latest);
    }
    return map;
  }, [groups]);

  function open(document: SopDocument) {
    acknowledge.reset();
    setSelected(document);
  }

  /** Status pill for one version; unknown when the API cannot say. */
  const statusPill = (document: SopDocument) =>
    !document.requiresAcknowledgement ? (
      <StatusPill status="info">
        {t("learning.sop.status.notRequired")}
      </StatusPill>
    ) : acknowledgements === null || employeeId === undefined ? (
      <span className="text-sm text-muted-foreground">
        {t("learning.common.none")}
      </span>
    ) : hasAcknowledged(
        acknowledgements,
        document.id,
        document.version,
        employeeId,
      ) ? (
      <StatusPill status="success">
        {t("learning.sop.status.confirmed")}
      </StatusPill>
    ) : (
      <StatusPill status="warning">
        {t("learning.sop.status.pending")}
      </StatusPill>
    );

  const pendingCount =
    acknowledgements === null || employeeId === undefined
      ? null
      : groups.filter((group) => {
          const latest = latestSopVersion(group);
          return (
            latest.requiresAcknowledgement &&
            !hasAcknowledged(
              acknowledgements,
              latest.id,
              latest.version,
              employeeId,
            )
          );
        }).length;

  const state: DataState =
    documentsQuery.isPending || positionsQuery.isPending
      ? "loading"
      : documentsQuery.isError || positionsQuery.isError
        ? "error"
        : groups.length === 0
          ? "empty"
          : "ready";

  function confirm(document: SopDocument) {
    acknowledge.mutate(
      { sopDocumentId: document.id, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: (acknowledgement) => {
          recordSopAcknowledgement(acknowledgement);
          setConfirmedHere((current) => new Set(current).add(document.id));
          toast({
            title: t("learning.sop.acknowledgedToast"),
            tone: "success",
          });
        },
      },
    );
  }

  const selectedLatest =
    selected === null ? null : (latestById.get(selected.id) ?? null);
  const selectedAckCount =
    selected === null
      ? null
      : acknowledgementCount(acknowledgements, selected.id, selected.version);

  return (
    <div className="grid min-w-0 gap-4">
      <StatStrip label={t("learning.sop.summaryLabel")} columns={3}>
        <StatTile
          label={t("learning.sop.metric.documents")}
          value={<span className="tabular">{formatNumber(groups.length)}</span>}
        />
        <StatTile
          label={t("learning.sop.metric.versions")}
          value={
            <span className="tabular">{formatNumber(documents.length)}</span>
          }
        />
        <StatTile
          label={t("learning.sop.metric.pending")}
          value={
            <span className="tabular">
              {pendingCount === null
                ? t("learning.common.none")
                : formatNumber(pendingCount)}
            </span>
          }
        />
      </StatStrip>

      <DataTableShell
        title={t("learning.sop.tableTitle")}
        description={t("learning.sop.description")}
        state={state}
        onRetry={() => {
          void documentsQuery.refetch();
          void positionsQuery.refetch();
        }}
        empty={{
          title: t("learning.sop.emptyTitle"),
          description: t("learning.sop.emptyHint"),
        }}
        rowCount={groups.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("learning.sop.table.document")}</TableHead>
              <TableHead>{t("learning.sop.table.version")}</TableHead>
              <TableHead>{t("learning.sop.table.effective")}</TableHead>
              <TableHead>{t("learning.sop.table.acknowledgements")}</TableHead>
              <TableHead>{t("learning.sop.table.status")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("learning.sop.table.action")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => {
              const latest = latestSopVersion(group);
              const count = acknowledgementCount(
                acknowledgements,
                latest.id,
                latest.version,
              );
              return (
                <TableRow key={group.key}>
                  <TableCell>
                    <p className="font-medium">{group.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {scopeName(latest)}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t("learning.sop.versionsLabel")}
                      </span>
                      {group.versions.map((version) => (
                        <Button
                          key={version.id}
                          variant={
                            version.id === latest.id ? "secondary" : "ghost"
                          }
                          size="sm"
                          className="h-7 px-2"
                          aria-current={
                            version.id === latest.id ? "true" : undefined
                          }
                          onClick={() => open(version)}
                        >
                          {t("learning.sop.versionChip", {
                            version: version.version,
                          })}
                        </Button>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone="brand">
                      {t("learning.sop.versionChip", {
                        version: latest.version,
                      })}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatBusinessDate(latest.effectiveFrom)}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {count === null
                      ? t("learning.common.none")
                      : t("learning.sop.acknowledgementCount", { count })}
                  </TableCell>
                  <TableCell>{statusPill(latest)}</TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => open(latest)}
                    >
                      {t("learning.sop.open")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {acknowledgements === null && state === "ready" && (
        <p className="rounded-container border-(length:--border-w) bg-card p-3 text-sm leading-5 text-muted-foreground shadow-hairline">
          {t("learning.sop.acknowledgementsUnavailable")}
        </p>
      )}

      {selected !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("learning.sop.detailTitle")}</DialogTitle>
              <DialogDescription>
                {t("learning.common.meta", {
                  first: t("learning.sop.versionChip", {
                    version: selected.version,
                  }),
                  second: scopeName(selected),
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <div>
                <h3 className="type-title">{selected.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("learning.common.meta", {
                    first: t("learning.sop.effectiveLabel", {
                      date: formatBusinessDate(selected.effectiveFrom),
                    }),
                    second: t("learning.sop.publishedLabel", {
                      date: formatDateTime(selected.publishedAt),
                    }),
                  })}
                </p>
              </div>

              <div>
                <h4 className="type-eyebrow text-muted-foreground">
                  {t("learning.sop.bodyLabel")}
                </h4>
                <p className="mt-1 rounded-container border-(length:--border-w) bg-surface-2 p-3 text-sm leading-6 whitespace-pre-line">
                  {selected.body}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">
                  {selectedAckCount === null
                    ? t("learning.common.none")
                    : t("learning.sop.acknowledgementCount", {
                        count: selectedAckCount,
                      })}
                </Badge>
                {statusPill(selected)}
              </div>

              {selectedLatest !== null && selectedLatest.id !== selected.id && (
                <p className="rounded-container bg-surface-2 p-3 text-sm leading-5">
                  {t("learning.sop.superseded", {
                    version: selectedLatest.version,
                  })}
                </p>
              )}

              {selected.requiresAcknowledgement &&
                employeeId !== undefined &&
                selectedLatest?.id === selected.id &&
                !confirmedHere.has(selected.id) &&
                !hasAcknowledged(
                  acknowledgements,
                  selected.id,
                  selected.version,
                  employeeId,
                ) && (
                  <div className="grid gap-2">
                    <Button
                      onClick={() => confirm(selected)}
                      loading={acknowledge.isPending}
                    >
                      {t("learning.sop.acknowledge")}
                    </Button>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t("learning.sop.acknowledgeHint")}
                    </p>
                    {acknowledge.isError && (
                      <p role="alert" className="text-sm text-danger">
                        {t("learning.common.actionFailed")}
                      </p>
                    )}
                  </div>
                )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("common.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
