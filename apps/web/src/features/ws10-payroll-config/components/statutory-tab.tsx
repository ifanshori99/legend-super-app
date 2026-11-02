// Versioned statutory tables (PRD v1.7 §3 F30 "BPJS/PPh 21/THR"; PAYR-02, R20):
// every table type is a chain of versions with its own effective date. Drafts
// are editable, published versions are immutable and archived drafts never
// apply. A compliance band surfaces overlapping published effective dates —
// the contract's resolver refuses such a table, so Finance sees it first.
import * as React from "react";
import {
  Archive,
  CircleCheck,
  Eye,
  Pencil,
  Plus,
  Scale,
  Send,
  TriangleAlert,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { StatusBand } from "@/components/ui/status-band";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "@/lib/idempotency";
import type {
  StatutoryTableType,
  StatutoryTableVersion,
  StatutoryVersionStatus,
} from "@starter/shared/hris/payroll";
import { STATUTORY_TABLE_TYPES } from "@starter/shared/hris/payroll";
import { payrollMutationError } from "../errors";
import {
  useArchiveStatutory,
  usePublishStatutory,
  useStatutoryTables,
} from "../hooks";
import {
  STATUTORY_STATUS_KEYS,
  STATUTORY_TYPE_KEYS,
  businessDateToday,
  effectiveUntil,
  formatBusinessDate,
  previousVersion,
  sortStatutoryVersions,
  statutoryConflicts,
} from "../lib";
import { StatutoryCompareDialog } from "./statutory-compare-dialog";
import { StatutoryConfirmDialog } from "./statutory-confirm-dialog";
import { StatutoryDetailDialog } from "./statutory-detail-dialog";
import { StatutoryFormDialog } from "./statutory-form-dialog";
import {
  StatutoryEffectiveBadge,
  StatutoryStatusPill,
} from "./version-status-pill";

type TypeFilter = StatutoryTableType | "all";
type StatusFilter = StatutoryVersionStatus | "all";

type DialogState =
  | { kind: "detail"; version: StatutoryTableVersion }
  | { kind: "create" }
  | { kind: "edit"; version: StatutoryTableVersion }
  | { kind: "publish"; version: StatutoryTableVersion }
  | { kind: "archive"; version: StatutoryTableVersion }
  | { kind: "compare"; version: StatutoryTableVersion };

function effectivePeriod(
  version: StatutoryTableVersion,
  versions: readonly StatutoryTableVersion[],
  t: ReturnType<typeof useT>,
): string {
  const until = effectiveUntil(version, versions);
  if (until === null)
    return t("payrollConfig.statutory.effectiveFrom", {
      date: formatBusinessDate(version.effectiveFrom),
    });
  return t("payrollConfig.statutory.effectiveUntil", {
    from: formatBusinessDate(version.effectiveFrom),
    to: formatBusinessDate(until),
  });
}

export function StatutoryTab({ canRun }: { canRun: boolean }) {
  const t = useT();
  const toast = useToast();
  const statutoryQuery = useStatutoryTables();
  const publishStatutory = usePublishStatutory();
  const archiveStatutory = useArchiveStatutory();

  const [search, setSearch] = React.useState("");
  const [type, setType] = React.useState<TypeFilter>("all");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [dialog, setDialog] = React.useState<DialogState | null>(null);
  const [actionError, setActionError] = React.useState<string>();
  const [actionKey, setActionKey] = React.useState(() => newIdempotencyKey());

  const versions = statutoryQuery.data?.data ?? [];
  const today = businessDateToday();
  const needle = search.trim().toLocaleLowerCase("id-ID");
  const rows = sortStatutoryVersions(versions).filter((version) => {
    if (type !== "all" && version.type !== type) return false;
    if (status !== "all" && version.status !== status) return false;
    if (needle === "") return true;
    return `${t(STATUTORY_TYPE_KEYS[version.type])} ${version.legalBasis} v${version.version}`
      .toLocaleLowerCase("id-ID")
      .includes(needle);
  });

  const published = versions.filter((version) => version.status === "published");
  const drafts = versions.filter((version) => version.status === "draft");
  const types = new Set(published.map((version) => version.type));
  const scheduled = published.filter(
    (version) => version.effectiveFrom > today,
  ).length;
  const conflicts = statutoryConflicts(versions);

  function openAction(kind: "publish" | "archive", version: StatutoryTableVersion) {
    setActionError(undefined);
    setActionKey(newIdempotencyKey());
    setDialog({ kind, version });
  }

  function confirmPublish() {
    if (dialog?.kind !== "publish") return;
    publishStatutory.mutate(
      {
        params: { versionId: dialog.version.id },
        body: { idempotencyKey: actionKey },
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollConfig.statutory.publishedToast"),
            tone: "success",
          });
          setDialog(null);
        },
        onError: (error) => setActionError(payrollMutationError(error, t)),
      },
    );
  }

  function confirmArchive() {
    if (dialog?.kind !== "archive") return;
    archiveStatutory.mutate(
      {
        params: { versionId: dialog.version.id },
        body: { idempotencyKey: actionKey },
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollConfig.statutory.archivedToast"),
            tone: "success",
          });
          setDialog(null);
        },
        onError: (error) => setActionError(payrollMutationError(error, t)),
      },
    );
  }

  const detailVersion = dialog?.kind === "detail" ? dialog.version : null;
  const detailPrevious = detailVersion
    ? previousVersion(detailVersion, versions)
    : undefined;

  return (
    <>
      <StatStrip label={t("payrollConfig.statutory.metrics.label")}>
        <StatTile
          label={t("payrollConfig.statutory.metrics.published")}
          value={published.length}
        />
        <StatTile
          label={t("payrollConfig.statutory.metrics.drafts")}
          value={drafts.length}
        />
        <StatTile
          label={t("payrollConfig.statutory.metrics.types")}
          value={types.size}
        />
        <StatTile
          label={t("payrollConfig.statutory.metrics.scheduled")}
          value={scheduled}
        />
      </StatStrip>

      {!statutoryQuery.isPending && !statutoryQuery.isError && (
        <StatusBand
          tone={conflicts.length === 0 ? "success" : "danger"}
          icon={conflicts.length === 0 ? CircleCheck : TriangleAlert}
          label={t("payrollConfig.statutory.compliance.title")}
        >
          <div className="grid gap-1">
            <p className="text-sm leading-5 font-semibold">
              {conflicts.length === 0
                ? t("payrollConfig.statutory.compliance.ok")
                : t("payrollConfig.statutory.compliance.conflict", {
                    count: conflicts.length,
                  })}
            </p>
            {conflicts.length > 0 && (
              <ul className="grid gap-0.5 text-sm">
                {conflicts.map((conflict) => (
                  <li key={`${conflict.type}:${conflict.effectiveFrom}`}>
                    {t("payrollConfig.statutory.compliance.conflictRow", {
                      type: t(STATUTORY_TYPE_KEYS[conflict.type]),
                      date: formatBusinessDate(conflict.effectiveFrom),
                      count: conflict.count,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </StatusBand>
      )}

      <DataTableShell
        title={t("payrollConfig.statutory.title")}
        description={t("payrollConfig.statutory.description")}
        state={
          statutoryQuery.isPending
            ? "loading"
            : statutoryQuery.isError
              ? "error"
              : versions.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("payrollConfig.statutory.searchLabel"),
        }}
        actions={
          <>
            <Select
              value={type}
              onValueChange={(value) => setType(value as TypeFilter)}
            >
              <SelectTrigger
                aria-label={t("payrollConfig.statutory.filterType")}
                className="h-control-sm sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("payrollConfig.statutory.filterAll")}
                </SelectItem>
                {STATUTORY_TABLE_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(STATUTORY_TYPE_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as StatusFilter)}
            >
              <SelectTrigger
                aria-label={t("payrollConfig.statutory.filterStatus")}
                className="h-control-sm sm:w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("payrollConfig.statutory.filterStatus")}
                </SelectItem>
                {(
                  Object.keys(
                    STATUTORY_STATUS_KEYS,
                  ) as StatutoryVersionStatus[]
                ).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(STATUTORY_STATUS_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={() => setDialog({ kind: "create" })}
              disabled={!canRun || versions.length === 0}
              title={
                !canRun
                  ? t("payrollConfig.readOnlyHint")
                  : versions.length === 0
                    ? t("payrollConfig.statutory.noTemplate")
                    : undefined
              }
            >
              <Plus aria-hidden="true" />
              {t("payrollConfig.statutory.add")}
            </Button>
          </>
        }
        onRetry={() => void statutoryQuery.refetch()}
        empty={{
          title: t("payrollConfig.statutory.emptyTitle"),
          description: t("payrollConfig.statutory.emptyHint"),
        }}
        noResults={versions.length > 0 && rows.length === 0}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("payrollConfig.statutory.columns.table")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.statutory.columns.version")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.statutory.columns.status")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.statutory.columns.effective")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.statutory.columns.legalBasis")}
                </TableHead>
                <TableHead numeric>
                  {t("payrollConfig.statutory.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((version) => {
                const previous = previousVersion(version, versions);
                const typeLabel = t(STATUTORY_TYPE_KEYS[version.type]);
                return (
                  <TableRow key={version.id}>
                    <TableCell>
                      <span className="font-semibold">{typeLabel}</span>
                    </TableCell>
                    <TableCell className="tabular">
                      {t("payrollConfig.statutory.versionLabel", {
                        version: version.version,
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="grid justify-items-start gap-1">
                        <StatutoryStatusPill status={version.status} />
                        <StatutoryEffectiveBadge
                          version={version}
                          versions={versions}
                          today={today}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="tabular">
                      {effectivePeriod(version, versions, t)}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal">
                      <span className="line-clamp-2">{version.legalBasis}</span>
                    </TableCell>
                    <TableCell numeric>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t(
                            "payrollConfig.statutory.detail",
                          )} ${typeLabel}`}
                          onClick={() =>
                            setDialog({ kind: "detail", version })
                          }
                        >
                          <Eye aria-hidden="true" />
                        </Button>
                        {version.status === "draft" && canRun && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t(
                                "payrollConfig.statutory.editDraft",
                              )} ${typeLabel}`}
                              onClick={() =>
                                setDialog({ kind: "edit", version })
                              }
                            >
                              <Pencil aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t(
                                "payrollConfig.statutory.publish",
                              )} ${typeLabel}`}
                              onClick={() => openAction("publish", version)}
                            >
                              <Send aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${t(
                                "payrollConfig.statutory.archive",
                              )} ${typeLabel}`}
                              onClick={() => openAction("archive", version)}
                            >
                              <Archive aria-hidden="true" />
                            </Button>
                          </>
                        )}
                        {version.status !== "draft" && previous && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${t(
                              "payrollConfig.statutory.compare",
                            )} ${typeLabel}`}
                            onClick={() =>
                              setDialog({ kind: "compare", version })
                            }
                          >
                            <Scale aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((version) => {
            const previous = previousVersion(version, versions);
            const typeLabel = t(STATUTORY_TYPE_KEYS[version.type]);
            return (
              <li
                key={version.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-semibold">{typeLabel}</span>
                    <span className="text-sm text-muted-foreground tabular">
                      {t("payrollConfig.statutory.versionLabel", {
                        version: version.version,
                      })}
                    </span>
                  </div>
                  <StatutoryStatusPill status={version.status} />
                </div>
                <p className="text-sm tabular">
                  {effectivePeriod(version, versions, t)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {version.legalBasis}
                </p>
                <StatutoryEffectiveBadge
                  version={version}
                  versions={versions}
                  today={today}
                />
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDialog({ kind: "detail", version })}
                  >
                    <Eye aria-hidden="true" />
                    {t("payrollConfig.statutory.detail")}
                  </Button>
                  {version.status === "draft" && canRun && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setDialog({ kind: "edit", version })}
                      >
                        <Pencil aria-hidden="true" />
                        {t("payrollConfig.statutory.editDraft")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openAction("publish", version)}
                      >
                        <Send aria-hidden="true" />
                        {t("payrollConfig.statutory.publish")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openAction("archive", version)}
                      >
                        <Archive aria-hidden="true" />
                        {t("payrollConfig.statutory.archive")}
                      </Button>
                    </>
                  )}
                  {version.status !== "draft" && previous && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDialog({ kind: "compare", version })}
                    >
                      <Scale aria-hidden="true" />
                      {t("payrollConfig.statutory.compare")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      {dialog?.kind === "detail" && (
        <StatutoryDetailDialog
          version={dialog.version}
          versions={versions}
          today={today}
          canRun={canRun}
          canCompare={detailPrevious !== undefined}
          onClose={() => setDialog(null)}
          onEdit={() => setDialog({ kind: "edit", version: dialog.version })}
          onPublish={() => openAction("publish", dialog.version)}
          onArchive={() => openAction("archive", dialog.version)}
          onCompare={() => setDialog({ kind: "compare", version: dialog.version })}
        />
      )}

      {dialog?.kind === "edit" && (
        <StatutoryFormDialog
          version={dialog.version}
          versions={versions}
          today={today}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "create" && (
        <StatutoryFormDialog
          versions={versions}
          today={today}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "publish" && (
        <StatutoryConfirmDialog
          title={t("payrollConfig.statutory.publishDialog.title", {
            type: t(STATUTORY_TYPE_KEYS[dialog.version.type]),
            version: dialog.version.version,
          })}
          description={t(
            "payrollConfig.statutory.publishDialog.description",
            {
              version: dialog.version.version,
              date: formatBusinessDate(dialog.version.effectiveFrom),
            },
          )}
          confirmLabel={t("payrollConfig.statutory.publishDialog.confirm")}
          error={actionError}
          pending={publishStatutory.isPending}
          onCancel={() => {
            setDialog(null);
            setActionError(undefined);
          }}
          onConfirm={confirmPublish}
        />
      )}

      {dialog?.kind === "archive" && (
        <StatutoryConfirmDialog
          title={t("payrollConfig.statutory.archiveDialog.title", {
            type: t(STATUTORY_TYPE_KEYS[dialog.version.type]),
            version: dialog.version.version,
          })}
          description={t("payrollConfig.statutory.archiveDialog.description")}
          confirmLabel={t("payrollConfig.statutory.archiveDialog.confirm")}
          destructive
          error={actionError}
          pending={archiveStatutory.isPending}
          onCancel={() => {
            setDialog(null);
            setActionError(undefined);
          }}
          onConfirm={confirmArchive}
        />
      )}

      {dialog?.kind === "compare" && (
        <StatutoryCompareDialog
          version={dialog.version}
          previous={previousVersion(dialog.version, versions) ?? dialog.version}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
