// "Bagi hasil saya" (PRD §3 F35, SH-01/SH-02): the caller's own holdings, the
// running estimate (labelled), paid/pending statements and share changes. The
// contract has no file-download path, so a statement is shown as available,
// never as a dead link.
import { CircleCheck, Clock, FileText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MyProfitShare } from "@starter/shared/accounting";
import {
  entityNames,
  formatDate,
  formatInstantDate,
  formatPeriodKey,
  formatShareBp,
  sortedDistributions,
} from "../board.ts";
import { useMyProfitShare } from "../hooks";
import { FinalityBadge, RegionFailure } from "./region";

function Estimates({ data }: { data: MyProfitShare }) {
  const t = useT();
  if (data.estimates.length === 0) return null;
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="type-title">
          {t("shareholderHome.profitShare.estimateTitle")}
        </h2>
        <FinalityBadge official={false} />
      </div>
      <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
        {t("shareholderHome.profitShare.estimateHint")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.estimates.map((row) => (
          <StatTile
            key={`${row.profitEntityId}:${row.period}`}
            label={t("shareholderHome.profitShare.estimateOf", {
              entity: row.profitEntityName,
              period: formatPeriodKey(row.period),
            })}
            value={<Money amount={row.estimatedShareIdr} size="stat" />}
            context={`${t("shareholderHome.profitShare.estimateBasis", {
              profit: `Rp ${new Intl.NumberFormat("id-ID").format(row.estimatedNetProfitIdr)}`,
              share: formatShareBp(row.shareBp),
            })} · ${t("shareholderHome.profitShare.estimateAsOf", {
              date: formatInstantDate(row.asOf),
            })}`}
          />
        ))}
      </div>
    </section>
  );
}

function Holdings({ data }: { data: MyProfitShare }) {
  const t = useT();
  if (data.holdings.length === 0) return null;
  return (
    <DataTableShell
      title={t("shareholderHome.profitShare.holdingsTitle")}
      description={t("shareholderHome.profitShare.holdingsHint")}
      state="ready"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("shareholderHome.profitShare.entity")}</TableHead>
            <TableHead numeric>
              {t("shareholderHome.profitShare.share")}
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("shareholderHome.profitShare.effectiveFrom")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.holdings.map((row) => (
            <TableRow key={row.profitEntityId}>
              <TableCell className="font-medium">
                {row.profitEntityName}
                <span className="block text-xs font-normal text-muted-foreground sm:hidden">
                  {t("shareholderHome.profitShare.effectiveFrom")}{" "}
                  {formatDate(row.effectiveFrom)}
                </span>
              </TableCell>
              <TableCell numeric>{formatShareBp(row.shareBp)}</TableCell>
              <TableCell className="hidden tabular sm:table-cell">
                {formatDate(row.effectiveFrom)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

function PaymentStatus({
  row,
}: {
  row: MyProfitShare["distributionHistory"][number];
}) {
  const t = useT();
  return (
    <>
      {row.paymentStatus === "paid" ? (
        <Badge tone="success">
          <CircleCheck aria-hidden="true" />
          {t("shareholderHome.profitShare.paid")}
        </Badge>
      ) : (
        <Badge tone="warning">
          <Clock aria-hidden="true" />
          {t("shareholderHome.profitShare.pending")}
        </Badge>
      )}
      {row.paidAt !== null && (
        <span className="mt-1 block text-xs text-muted-foreground">
          {t("shareholderHome.profitShare.paidOn", {
            date: formatInstantDate(row.paidAt),
          })}
        </span>
      )}
      {row.statementFileKey !== null && (
        <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="size-3.5" aria-hidden="true" />
          {t("shareholderHome.profitShare.statementReady")}
        </span>
      )}
    </>
  );
}

function History({ data }: { data: MyProfitShare }) {
  const t = useT();
  const rows = sortedDistributions(data);
  return (
    <DataTableShell
      title={t("shareholderHome.profitShare.historyTitle")}
      description={t("shareholderHome.profitShare.historyHint")}
      state={rows.length === 0 ? "empty" : "ready"}
      empty={{
        title: t("shareholderHome.profitShare.noHistory"),
        description: t("shareholderHome.profitShare.noHistoryHint"),
      }}
      rowCount={rows.length}
      // Statements exist only for closed, approved periods (SH-01).
      actions={rows.length > 0 ? <FinalityBadge official /> : undefined}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("shareholderHome.profitShare.period")}</TableHead>
            <TableHead numeric className="hidden md:table-cell">
              {t("shareholderHome.profitShare.share")}
            </TableHead>
            <TableHead numeric className="hidden md:table-cell">
              {t("shareholderHome.profitShare.gross")}
            </TableHead>
            <TableHead numeric className="hidden md:table-cell">
              {t("shareholderHome.profitShare.tax")}
            </TableHead>
            <TableHead numeric>
              {t("shareholderHome.profitShare.net")}
            </TableHead>
            <TableHead className="hidden md:table-cell">
              {t("shareholderHome.profitShare.status")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.distributionLineId}>
              <TableCell className="font-medium whitespace-nowrap">
                {formatPeriodKey(row.period)}
                <span className="block text-xs font-normal whitespace-normal text-muted-foreground">
                  {row.profitEntityName}
                </span>
                {row.runType === "adjustment" && (
                  <Badge tone="warning" className="mt-1">
                    {t("shareholderHome.profitShare.adjustment")}
                  </Badge>
                )}
              </TableCell>
              <TableCell numeric className="hidden md:table-cell">
                {formatShareBp(row.shareBp)}
              </TableCell>
              <TableCell numeric className="hidden md:table-cell">
                <Money amount={row.grossIdr} size="sm" />
              </TableCell>
              <TableCell numeric className="hidden md:table-cell">
                <Money amount={row.taxWithheldIdr} size="sm" />
              </TableCell>
              <TableCell numeric>
                <Money
                  amount={row.netIdr}
                  size="sm"
                  className="font-semibold"
                />
                {/* Phones: gross, tax and status stack under the amount. */}
                <span className="block text-xs font-normal whitespace-normal text-muted-foreground md:hidden">
                  {t("shareholderHome.profitShare.grossTax", {
                    gross: `Rp ${new Intl.NumberFormat("id-ID").format(row.grossIdr)}`,
                    tax: `Rp ${new Intl.NumberFormat("id-ID").format(row.taxWithheldIdr)}`,
                  })}
                </span>
                <span className="mt-1.5 flex flex-col items-end whitespace-normal md:hidden">
                  <PaymentStatus row={row} />
                </span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <PaymentStatus row={row} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

function ShareHistory({ data }: { data: MyProfitShare }) {
  const t = useT();
  if (data.shareHistory.length === 0) return null;
  const names = entityNames(data);
  return (
    <DataTableShell
      title={t("shareholderHome.profitShare.shareHistoryTitle")}
      description={t("shareholderHome.profitShare.shareHistoryHint")}
      state="ready"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("shareholderHome.profitShare.entity")}</TableHead>
            <TableHead numeric>
              {t("shareholderHome.profitShare.share")}
            </TableHead>
            <TableHead>
              {t("shareholderHome.profitShare.effectiveFrom")}
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("shareholderHome.profitShare.approvedAt")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.shareHistory.map((row) => (
            <TableRow key={`${row.profitEntityId}:${row.version}`}>
              <TableCell className="font-medium">
                {names.get(row.profitEntityId) ??
                  t("shareholderHome.profitShare.unknownEntity")}
                <span className="block text-xs font-normal text-muted-foreground">
                  {t("shareholderHome.profitShare.versionValue", {
                    version: row.version,
                  })}
                </span>
              </TableCell>
              <TableCell numeric>{formatShareBp(row.shareBp)}</TableCell>
              <TableCell className="tabular">
                {formatDate(row.effectiveFrom)}
              </TableCell>
              <TableCell className="hidden tabular sm:table-cell">
                {formatInstantDate(row.approvedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

export function ProfitShareSection() {
  const t = useT();
  const { status, data, retry } = useMyProfitShare();

  if (status === "error" || status === "offline")
    return (
      <DataTableShell
        title={t("shareholderHome.tabs.profitShare")}
        state="ready"
      >
        <RegionFailure status={status} retry={retry} />
      </DataTableShell>
    );

  if (status === "loading" || status === "empty" || data === null) {
    return (
      <DataTableShell
        title={t("shareholderHome.tabs.profitShare")}
        state={
          status === "loading"
            ? "loading"
            : status === "empty"
              ? "empty"
              : "error"
        }
        onRetry={retry}
        empty={{
          title: t("shareholderHome.profitShare.emptyTitle"),
          description: t("shareholderHome.profitShare.emptyHint"),
        }}
      />
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <Estimates data={data} />
      <Holdings data={data} />
      <History data={data} />
      <ShareHistory data={data} />
    </div>
  );
}
