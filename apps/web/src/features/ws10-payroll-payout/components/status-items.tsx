// Per-employee result list: a table from 700px, cards below. Every status is
// a text label (never colour alone). An `unknown` result gets an explanation
// and a refresh, never a pay-again button: the money may already have left.
import * as React from "react";
import type {
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
  PayrollPayoutProposalDto,
} from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "../../ws10-payroll-run/lib";
import { itemStatusMeta } from "../lib";
import { useEmployeeLine } from "./approval-items";
import { itemGroup } from "./status-groups";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function toneOf(kind: string): Tone {
  switch (kind) {
    case "success":
    case "warning":
    case "danger":
    case "info":
      return kind;
    default:
      return "neutral";
  }
}

/** First-person proposals by item id. */
export type ProposalMap = ReadonlyMap<string, PayrollPayoutProposalDto>;

export function proposalFor(
  proposals: ProposalMap | undefined,
  itemId: string,
): PayrollPayoutProposalDto | undefined {
  return proposals?.get(itemId);
}

export type RowAction =
  "record" | "cash" | "check" | "detail" | "evidence" | "review" | "withdraw";

/**
 * A step-one correction or overpaid proposal on this item that its maker or
 * another approver may take back. Resolve and return proposals are not
 * withdrawn here.
 */
export function withdrawableProposal(
  proposals: ProposalMap | undefined,
  itemId: string,
): PayrollPayoutProposalDto | undefined {
  const found = proposalFor(proposals, itemId);
  return found?.kind === "correction" || found?.kind === "overpaid"
    ? found
    : undefined;
}

export function rowAction(
  item: PayrollDisbursementItemDto,
  batch: PayrollDisbursementBatchDto,
): RowAction | null {
  if (item.status === "unknown") return "check";
  if (item.status === "failed" || item.status === "not_sent") return "review";
  if (item.status === "succeeded")
    return batch.channel === "duitku" ? "detail" : "evidence";
  if (
    batch.channel === "cash" &&
    ["approved", "exported"].includes(item.status)
  )
    return "cash";
  if (batch.channel === "manual_bank" && item.status === "exported")
    return "record";
  return null;
}

export function StatusList({
  batch,
  items,
  canRecord,
  recordBlockKey,
  proposals,
  withdrawBlockKey,
  onAction,
}: {
  batch: PayrollDisbursementBatchDto;
  items: readonly PayrollDisbursementItemDto[];
  canRecord: boolean;
  /** Why record/cash buttons are off (creator, no access); null = on. */
  recordBlockKey: "creator" | "access" | null;
  /** Items waiting for the second person get a small marker. */
  proposals?: ProposalMap;
  /** Why the withdraw button is off (creator, no access); null = on. */
  withdrawBlockKey: "creator" | "access" | null;
  onAction: (action: RowAction, item: PayrollDisbursementItemDto) => void;
}) {
  const t = useT();
  const line = useEmployeeLine();
  const blockText = useBlockText(recordBlockKey).text;
  const withdrawBlockText = useWithdrawBlockText(withdrawBlockKey);

  const subText = (item: PayrollDisbursementItemDto): string => {
    const group = itemGroup(item, batch);
    switch (item.status) {
      case "prepared":
        return t("payrollPayoutReview.status.row.waiting");
      case "approved":
        return t(
          batch.channel === "manual_bank"
            ? "payrollPayoutReview.status.row.waitingExport"
            : "payrollPayoutReview.status.row.waiting",
        );
      case "sending":
        return t("payrollPayoutReview.status.row.waiting");
      case "exported":
        return t("payrollPayoutReview.status.row.waitingTransfer");
      case "unknown":
        return t("payrollPayoutReview.status.row.unknown");
      case "succeeded": {
        const parts = [
          group === "manual"
            ? t("payrollPayoutReview.status.row.manualPaid")
            : item.settledAt
              ? t("payrollPayoutReview.status.row.succeeded", {
                  time: formatDateTime(item.settledAt),
                })
              : "",
          item.confirmationRef
            ? t("payrollPayoutReview.status.row.ref", {
                ref: item.confirmationRef,
              })
            : "",
        ].filter(Boolean);
        return parts.join(" · ");
      }
      case "failed":
        return t("payrollPayoutReview.status.row.failed");
      case "not_sent":
        return t("payrollPayoutReview.status.row.notSent");
      case "returned":
        return t("payrollPayoutReview.status.row.returned");
      case "overpaid":
        return t("payrollPayoutReview.status.row.overpaid");
      default:
        return t("payrollPayoutReview.status.row.cancelled");
    }
  };

  const badge = (item: PayrollDisbursementItemDto) => {
    const meta = itemStatusMeta(item.status);
    const manual = itemGroup(item, batch) === "manual";
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={manual ? "info" : toneOf(meta.kind)}>
          {manual
            ? t("payrollPayoutReview.status.tile.manual")
            : t(meta.labelKey)}
        </Badge>
        {proposalFor(proposals, item.id) && (
          <Badge
            tone="warning"
            data-testid={`payout-proposal-badge-${item.id}`}
          >
            {t("payrollPayoutReview.result.proposal.badge")}
          </Badge>
        )}
      </div>
    );
  };

  const action = (
    item: PayrollDisbursementItemDto,
    layout: "table" | "card",
  ) => {
    const kind = rowAction(item, batch);
    const withdrawing = withdrawableProposal(proposals, item.id) !== undefined;
    if (!kind && !withdrawing) return null;
    const moneyAction = kind === "record" || kind === "cash";
    const blocked = moneyAction && !canRecord;
    const withdrawBlocked = withdrawBlockKey !== null;
    // The table and the cards both render: one DOM id per layout.
    const reasonId = `status-block-${layout}-${item.id}`;
    const withdrawReasonId = `status-withdraw-block-${layout}-${item.id}`;
    return (
      <div className="grid justify-items-start gap-1">
        {kind && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            disabled={blocked}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={() => onAction(kind, item)}
          >
            {t(`payrollPayoutReview.status.action.${kind}`)}
          </Button>
        )}
        {blocked && blockText && (
          <p id={reasonId} className="max-w-56 text-xs text-muted-foreground">
            {blockText}
          </p>
        )}
        {withdrawing && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-fit"
            data-testid={`payout-withdraw-${item.id}`}
            disabled={withdrawBlocked}
            aria-describedby={withdrawBlocked ? withdrawReasonId : undefined}
            onClick={() => onAction("withdraw", item)}
          >
            {t("payrollPayoutReview.status.action.withdraw")}
          </Button>
        )}
        {withdrawing && withdrawBlocked && withdrawBlockText && (
          <p
            id={withdrawReasonId}
            className="max-w-56 text-xs text-muted-foreground"
          >
            {withdrawBlockText}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="hidden min-[700px]:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("payrollPayoutReview.status.table.employee")}
              </TableHead>
              <TableHead>
                {t("payrollPayoutReview.status.table.amount")}
              </TableHead>
              <TableHead>
                {t("payrollPayoutReview.status.table.status")}
              </TableHead>
              <TableHead>
                {t("payrollPayoutReview.status.table.action")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const who = line(item);
              return (
                <TableRow key={item.id} data-status={item.status}>
                  <TableCell>
                    <p className="font-semibold">{who.name}</p>
                    <p className="tabular text-xs text-muted-foreground">
                      {who.bank}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Money amount={item.amountIdr} />
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      {badge(item)}
                      <p className="text-xs text-muted-foreground">
                        {subText(item)}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>{action(item, "table")}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="grid min-[700px]:hidden">
        {items.map((item) => {
          const who = line(item);
          return (
            <li
              key={item.id}
              data-status={item.status}
              className="grid gap-2 border-b-(length:--border-w) py-4 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{who.name}</p>
                  <p className="tabular text-xs text-muted-foreground">
                    {who.bank}
                  </p>
                </div>
                <Money amount={item.amountIdr} className="font-semibold" />
              </div>
              <div className="grid justify-items-start gap-1">
                {badge(item)}
                <p className="text-sm text-muted-foreground">{subText(item)}</p>
              </div>
              {action(item, "card")}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Text for the record-button block key (creator / no access). */
export function useBlockText(key: "creator" | "access" | null) {
  const t = useT();
  const text = React.useMemo(
    () =>
      key === "creator"
        ? t("payrollPayoutReview.status.action.blockedCreator")
        : key === "access"
          ? t("payrollPayoutReview.status.action.blockedAccess")
          : null,
    [key, t],
  );
  return { key, text } as const;
}

/** Text for the withdraw-button block key (creator / no access). */
function useWithdrawBlockText(key: "creator" | "access" | null) {
  const t = useT();
  return key === "creator"
    ? t("payrollPayoutReview.status.action.blockedWithdrawCreator")
    : key === "access"
      ? t("payrollPayoutReview.status.action.blockedWithdrawAccess")
      : null;
}
