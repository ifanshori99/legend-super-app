// Tab Rekonsiliasi (PRD v1.7 §3.23 "Rekonsiliasi Komisi"): one platform
// statement for a business period. One StatStrip answers the money question
// (gross, commission, settled, variance) and the counts behind it; the table
// lists every statement line with its match state. A variance row carries the
// owner Q28 treatment: accent tint plus a 2px leading rule.
import * as React from "react";
import { useT } from "@/components/i18n";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DELIVERY_PLATFORMS } from "@starter/shared/delivery";
import type { DeliveryPlatform } from "@starter/shared/delivery";
import { useReconciliation } from "../hooks";
import {
  firstOfMonth,
  formatBusinessDate,
  platformKey,
  todayBusinessDate,
} from "../lib";
import { SettlementStatusPill } from "./delivery-badges";

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function ReconciliationTab({
  outletId,
  timeZone,
}: {
  outletId: string;
  timeZone: string;
}) {
  const t = useT();
  const [platform, setPlatform] = React.useState<DeliveryPlatform>("gofood");
  // Month to date: the statement period finance opens with (PRD §3.23).
  const [periodStart, setPeriodStart] = React.useState(() =>
    firstOfMonth(todayBusinessDate(timeZone)),
  );
  const [periodEnd, setPeriodEnd] = React.useState(() =>
    todayBusinessDate(timeZone),
  );
  // Radix Select renders no DOM at its root, so the FormField id must sit on
  // the trigger (same pattern as the shareholder dialog).
  const platformFieldId = React.useId();
  const periodError =
    periodEnd < periodStart
      ? t("deliveryOps.rekonsiliasi.periodInvalid")
      : undefined;
  const recon = useReconciliation(
    outletId,
    { platform, periodStart, periodEnd },
    periodError === undefined,
  );
  const platformName = t(platformKey(platform));
  const summary = recon.data?.summary;
  const lines = recon.data?.lines ?? [];
  const periodContext = t("deliveryOps.rekonsiliasi.periodContext", {
    start: formatBusinessDate(periodStart),
    end: formatBusinessDate(periodEnd),
  });
  const tableState: DataState = recon.isPending
    ? "loading"
    : lines.length === 0
      ? "empty"
      : "ready";

  return (
    <div className="grid gap-4">
      <section
        aria-label={t("deliveryOps.rekonsiliasi.filterLabel")}
        className="rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline"
      >
        <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card sm:grid-cols-3">
          <FormField
            id={platformFieldId}
            label={t("deliveryOps.rekonsiliasi.platform")}
          >
            <Select
              value={platform}
              onValueChange={(value) => setPlatform(value as DeliveryPlatform)}
            >
              <SelectTrigger id={platformFieldId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_PLATFORMS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(platformKey(entry))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("deliveryOps.rekonsiliasi.periodStart")}>
            <Input
              type="date"
              value={periodStart}
              onChange={(event) => {
                if (BUSINESS_DATE.test(event.target.value))
                  setPeriodStart(event.target.value);
              }}
            />
          </FormField>
          <FormField
            label={t("deliveryOps.rekonsiliasi.periodEnd")}
            error={periodError}
          >
            <Input
              type="date"
              value={periodEnd}
              onChange={(event) => {
                if (BUSINESS_DATE.test(event.target.value))
                  setPeriodEnd(event.target.value);
              }}
            />
          </FormField>
        </div>
      </section>

      {periodError === undefined &&
        summary !== undefined &&
        lines.length > 0 && (
          <StatStrip
            label={t("deliveryOps.rekonsiliasi.summaryLabel", {
              platform: platformName,
            })}
            columns={4}
          >
            <StatTile
              label={t("deliveryOps.rekonsiliasi.gross")}
              value={<Money amount={summary.grossIdr} size="stat" />}
              context={periodContext}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.commission")}
              value={<Money amount={summary.commissionIdr} size="stat" />}
              context={t("deliveryOps.rekonsiliasi.linesContext", {
                count: summary.lineCount,
              })}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.settled")}
              value={<Money amount={summary.settledNetIdr} size="stat" />}
              context={periodContext}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.variance")}
              value={<Money amount={summary.varianceIdr} size="stat" />}
              context={t("deliveryOps.rekonsiliasi.linesContext", {
                count: summary.lineCount,
              })}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.matchedCount")}
              value={<NumberDisplay value={summary.matchedCount} size="stat" />}
              context={periodContext}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.varianceCount")}
              value={
                <NumberDisplay value={summary.varianceCount} size="stat" />
              }
              context={periodContext}
            />
            <StatTile
              label={t("deliveryOps.rekonsiliasi.unknownCount")}
              value={
                <NumberDisplay value={summary.unknownOrderCount} size="stat" />
              }
              context={periodContext}
            />
          </StatStrip>
        )}

      {periodError === undefined &&
        (recon.isError ? (
          <CardShell>
            <CardShellBody>
              <ErrorState
                title={t("deliveryOps.rekonsiliasi.errorTitle")}
                description={t("deliveryOps.rekonsiliasi.errorHint")}
                error={recon.error}
                onRetry={() => void recon.refetch()}
              />
            </CardShellBody>
          </CardShell>
        ) : (
          <DataTableShell
            title={t("deliveryOps.rekonsiliasi.tableTitle", {
              platform: platformName,
            })}
            description={t("deliveryOps.rekonsiliasi.tableDescription")}
            state={tableState}
            error={recon.error}
            onRetry={() => void recon.refetch()}
            empty={{
              title: t("deliveryOps.rekonsiliasi.emptyTitle", {
                platform: platformName,
              }),
              description: t("deliveryOps.rekonsiliasi.emptyHint"),
            }}
            rowCount={lines.length}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("deliveryOps.rekonsiliasi.column.externalOrderId")}
                  </TableHead>
                  <TableHead numeric>
                    {t("deliveryOps.rekonsiliasi.column.gross")}
                  </TableHead>
                  <TableHead numeric>
                    {t("deliveryOps.rekonsiliasi.column.commission")}
                  </TableHead>
                  <TableHead numeric>
                    {t("deliveryOps.rekonsiliasi.column.settled")}
                  </TableHead>
                  <TableHead numeric>
                    {t("deliveryOps.rekonsiliasi.column.variance")}
                  </TableHead>
                  <TableHead>
                    {t("deliveryOps.rekonsiliasi.column.status")}
                  </TableHead>
                  <TableHead>
                    {t("deliveryOps.rekonsiliasi.column.settledOn")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow
                    key={line.id}
                    data-state={
                      line.status === "variance" ? "selected" : undefined
                    }
                  >
                    <TableCell>
                      <span className="font-mono text-xs">
                        {line.externalOrderId}
                      </span>
                      {line.deliveryChannelOrderId === null && (
                        <span className="block text-xs text-muted-foreground">
                          {t("deliveryOps.rekonsiliasi.unknownInternal")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={line.grossIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={line.commissionIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={line.settledNetIdr} />
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={line.varianceIdr} />
                    </TableCell>
                    <TableCell>
                      <SettlementStatusPill status={line.status} />
                    </TableCell>
                    <TableCell>
                      <span className="tabular">
                        {formatBusinessDate(line.settledOn)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {summary !== undefined && summary.varianceCount > 0 && (
              <p className="border-t px-card py-2.5 text-sm text-muted-foreground">
                {t("deliveryOps.rekonsiliasi.varianceNote")}
              </p>
            )}
          </DataTableShell>
        ))}
    </div>
  );
}
