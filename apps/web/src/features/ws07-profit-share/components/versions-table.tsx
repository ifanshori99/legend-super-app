// The register's versions, newest first: number, effective date, status, total
// and who decided. Opening a version focuses it; comparing opens the diff
// against the previous version (bead scope "version diff view").
import { GitCompareArrows, Plus } from "lucide-react";
import type { ShareAllocationVersion } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatShareBp,
  formatShareBpInteger,
  formatShareDate,
  formatShareDateTime,
  shortActorRef,
  versionTotalBp,
} from "../lib";
import { VersionStatusBadge } from "./share-status";

export function VersionsTable({
  versions,
  state,
  canWrite,
  onRetry,
  onCreate,
  onOpen,
  onCompare,
  hasPrevious,
}: {
  versions: readonly ShareAllocationVersion[];
  state: DataState;
  canWrite: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (version: ShareAllocationVersion) => void;
  onCompare: (version: ShareAllocationVersion) => void;
  hasPrevious: (version: ShareAllocationVersion) => boolean;
}) {
  const t = useT();
  return (
    <DataTableShell
      title={t("accounting.share.versions.title")}
      description={t("accounting.share.versions.subtitle")}
      state={state}
      onRetry={onRetry}
      rowCount={versions.length}
      actions={
        canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("accounting.share.versions.create")}
          </Button>
        ) : undefined
      }
      empty={{
        title: t("accounting.share.versions.emptyTitle"),
        description: t("accounting.share.versions.emptyHint"),
        action: canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("accounting.share.versions.create")}
          </Button>
        ) : undefined,
      }}
    >
      <Table className="min-w-[52rem]">
        <TableHeader>
          <TableRow>
            <TableHead>
              {t("accounting.share.versions.columns.version")}
            </TableHead>
            <TableHead>
              {t("accounting.share.versions.columns.effectiveFrom")}
            </TableHead>
            <TableHead>
              {t("accounting.share.versions.columns.status")}
            </TableHead>
            <TableHead numeric>
              {t("accounting.share.versions.columns.total")}
            </TableHead>
            <TableHead>
              {t("accounting.share.versions.columns.requester")}
            </TableHead>
            <TableHead>
              {t("accounting.share.versions.columns.decided")}
            </TableHead>
            <TableHead className="text-right">
              {t("accounting.share.versions.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => {
            const totalBp = versionTotalBp(version);
            return (
              <TableRow key={version.version}>
                <TableCell className="font-semibold tabular">
                  {t("accounting.share.versions.versionLabel", {
                    version: version.version,
                  })}
                </TableCell>
                <TableCell className="tabular">
                  {formatShareDate(version.effectiveFrom)}
                </TableCell>
                <TableCell>
                  <VersionStatusBadge status={version.status} />
                </TableCell>
                <TableCell numeric>
                  <span className="font-semibold">
                    {formatShareBp(totalBp)}
                  </span>
                  <span className="ml-1.5 text-sm text-muted-foreground">
                    {t("accounting.share.bpUnit", {
                      bp: formatShareBpInteger(totalBp),
                    })}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <span className="tabular">
                    {shortActorRef(version.requestedBy)}
                  </span>
                  <br />
                  <span>{formatShareDateTime(version.requestedAt)}</span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {version.decidedBy && version.decidedAt ? (
                    <>
                      <span className="tabular">
                        {shortActorRef(version.decidedBy)}
                      </span>
                      <br />
                      <span>{formatShareDateTime(version.decidedAt)}</span>
                    </>
                  ) : (
                    t("accounting.share.emptyValue")
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpen(version)}
                    >
                      {t("accounting.share.versions.open")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("accounting.share.versions.compareAria", {
                        version: version.version,
                      })}
                      disabled={!hasPrevious(version)}
                      onClick={() => onCompare(version)}
                    >
                      <GitCompareArrows aria-hidden="true" />
                      {t("accounting.share.versions.compare")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
