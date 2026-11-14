// "Rincian pencairan": what the employees receive, what the PT pays on top,
// and the total to have ready. The approve button lives here with the check
// box; it is switched off for clarity only, the server stays the checker.
import * as React from "react";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b-(length:--border-w) py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

export function ApprovalSummary({
  count,
  netIdr,
  feeIdr,
  fundsIdr,
  methodLabel,
  sourceLabel,
  feePerTransferIdr,
  checked,
  onCheckedChange,
  blockKey,
  busy,
  onApprove,
  showApprove,
  children,
}: {
  count: number;
  netIdr: number;
  feeIdr: number;
  fundsIdr: number;
  methodLabel: string;
  /** Null for channels without a source account line (Duitku, cash). */
  sourceLabel: string | null;
  feePerTransferIdr: number | undefined;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  /** Why the approve button is off; null = ready. */
  blockKey: MessageKey | null;
  busy: boolean;
  onApprove: () => void;
  showApprove: boolean;
  /** Step-up panel and the server refusal, below the button. */
  children?: React.ReactNode;
}) {
  const t = useT();
  const checkId = React.useId();
  const reasonId = `${checkId}-reason`;
  return (
    <aside
      aria-label={t("payrollPayoutReview.approval.summary.title")}
      className="grid content-start gap-3 rounded-shell border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <p className="type-eyebrow text-muted-foreground">
        {t("payrollPayoutReview.approval.summary.title")}
      </p>
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          {t("payrollPayoutReview.approval.summary.netLabel", { count })}
        </p>
        <Money amount={netIdr} size="hero" />
      </div>
      <dl className="grid border-t-(length:--border-w)">
        <Row label={t("payrollPayoutReview.approval.summary.method")}>
          {methodLabel}
        </Row>
        {sourceLabel !== null && (
          <Row label={t("payrollPayoutReview.approval.summary.source")}>
            {sourceLabel}
          </Row>
        )}
        <Row label={t("payrollPayoutReview.approval.summary.fee")}>
          <Money amount={feeIdr} size="sm" />
        </Row>
        <Row label={t("payrollPayoutReview.approval.summary.total")}>
          <Money amount={fundsIdr} size="sm" />
        </Row>
      </dl>
      <p className="text-sm text-muted-foreground">
        {feePerTransferIdr === undefined
          ? t("payrollPayoutReview.approval.summary.feeNoteGeneric")
          : t("payrollPayoutReview.approval.summary.feeNote", {
              fee: formatRupiah(feePerTransferIdr),
            })}
      </p>
      {showApprove && (
        <>
          <div className="flex items-start gap-3 border-t-(length:--border-w) pt-4">
            <Checkbox
              id={checkId}
              checked={checked}
              onCheckedChange={(value) => onCheckedChange(value === true)}
              className="mt-0.5"
            />
            <Label htmlFor={checkId} className="min-h-6 text-sm leading-5">
              {t("payrollPayoutReview.approval.check")}
            </Label>
          </div>
          <Button
            type="button"
            className="min-h-11 w-full"
            disabled={blockKey !== null}
            aria-describedby={blockKey ? reasonId : undefined}
            loading={busy}
            onClick={onApprove}
          >
            {t("payrollPayoutReview.approval.approve")}
          </Button>
          {blockKey ? (
            <p id={reasonId} className="text-sm text-muted-foreground">
              {t(blockKey)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("payrollPayoutReview.approval.approveHint")}
            </p>
          )}
        </>
      )}
      {children}
    </aside>
  );
}
