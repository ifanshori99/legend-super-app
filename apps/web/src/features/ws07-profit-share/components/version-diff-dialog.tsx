// Version diff (bead scope): added, removed and changed shareholders with the
// old → new basis points and the delta, plus the total delta. The computation
// is a pure helper (../lib.ts), so a unit test covers it without a DOM.
import * as React from "react";
import { ArrowRight } from "lucide-react";
import type {
  ShareAllocationVersion,
  Shareholder,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  diffShareAllocations,
  formatShareBp,
  formatShareBpDelta,
  formatShareBpInteger,
} from "../lib";

const KIND_TONE = {
  added: "success",
  removed: "danger",
  changed: "warning",
} as const;

export function VersionDiffDialog({
  open,
  onOpenChange,
  version,
  previous,
  shareholders,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: ShareAllocationVersion | null;
  previous: ShareAllocationVersion | null;
  shareholders: readonly Shareholder[];
}) {
  const t = useT();
  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );
  if (!version) return null;
  const diff = diffShareAllocations(
    previous?.allocations ?? null,
    version.allocations,
  );
  const nameOf = (shareholderId: string) =>
    byId.get(shareholderId as Shareholder["id"])?.name ??
    t("accounting.share.allocations.unknown");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {previous
              ? t("accounting.share.diff.title", {
                  from: previous.version,
                  to: version.version,
                })
              : t("accounting.share.diff.firstTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("accounting.share.versions.versionLabel", {
              version: version.version,
            })}{" "}
            · {t("accounting.share.diff.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {previous && (
            <span className="tabular">
              {t("accounting.share.diff.totalBefore", {
                bp: formatShareBpInteger(diff.beforeTotalBp),
              })}
            </span>
          )}
          <ArrowRight className="size-4" aria-hidden="true" />
          <span className="tabular">
            {t("accounting.share.diff.totalAfter", {
              bp: formatShareBpInteger(diff.afterTotalBp),
            })}
          </span>
          <Badge tone={diff.totalDeltaBp === 0 ? "neutral" : "info"}>
            {t("accounting.share.diff.totalDelta", {
              bp: formatShareBpInteger(diff.totalDeltaBp),
            })}
          </Badge>
        </div>

        {diff.rows.length === 0 ? (
          <p className="rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("accounting.share.diff.empty")}
          </p>
        ) : (
          <Table className="min-w-[30rem]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("accounting.share.diff.columns.shareholder")}
                </TableHead>
                <TableHead>
                  {t("accounting.share.diff.columns.change")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.share.diff.columns.before")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.share.diff.columns.after")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.share.diff.columns.delta")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diff.rows.map((row) => (
                <TableRow key={`${row.kind}:${row.shareholderId}`}>
                  <TableCell className="font-medium">
                    {nameOf(row.shareholderId)}
                  </TableCell>
                  <TableCell>
                    <Badge tone={KIND_TONE[row.kind]}>
                      {t(`accounting.share.diff.kind.${row.kind}`)}
                    </Badge>
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {row.beforeBp === null
                      ? t("accounting.share.emptyValue")
                      : formatShareBp(row.beforeBp)}
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {row.afterBp === null
                      ? t("accounting.share.emptyValue")
                      : formatShareBp(row.afterBp)}
                  </TableCell>
                  <TableCell numeric className="font-semibold tabular">
                    {formatShareBpDelta(row.deltaBp)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
