// Total panel under the journal lines (mockup 5ac3): total debit, total credit
// and the difference with its balanced state. Display only: it reads the same
// evaluateManualDraft result the save checks use and changes no amount.
import { CircleAlert, CircleCheck } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { DraftEvaluation } from "../lib";

export function JournalTotalPanel({
  evaluation,
  hasAmountIssue,
}: {
  evaluation: DraftEvaluation;
  /** A row has an unreadable amount: its numbers are left out of the totals. */
  hasAmountIssue: boolean;
}) {
  const t = useT();
  const difference = Math.abs(evaluation.differenceIdr);
  return (
    <div
      aria-live="polite"
      className="grid gap-3 rounded-lg border-(length:--border-w) border-border bg-muted p-card sm:grid-cols-3"
    >
      <div className="grid gap-1">
        <span className="text-sm leading-5 text-muted-foreground">
          {t("accounting.manual.form.totalDebit")}
        </span>
        <strong className="tabular">{formatRupiah(evaluation.debitIdr)}</strong>
      </div>
      <div className="grid gap-1">
        <span className="text-sm leading-5 text-muted-foreground">
          {t("accounting.manual.form.totalCredit")}
        </span>
        <strong className="tabular">
          {formatRupiah(evaluation.creditIdr)}
        </strong>
      </div>
      <div className="grid content-start gap-1 sm:justify-items-end sm:text-right">
        <span className="text-sm leading-5 text-muted-foreground">
          {t("accounting.manual.form.differenceLabel")}
        </span>
        <strong className="tabular">{formatRupiah(difference)}</strong>
        {evaluation.balanced ? (
          <Badge tone="success">
            <CircleCheck aria-hidden="true" />
            {t("accounting.manual.form.balanced")}
          </Badge>
        ) : evaluation.filled < 2 ? (
          // Nothing entered yet: a hint, not an error.
          <span className="text-sm text-muted-foreground">
            {t("accounting.manual.form.linesRequired")}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-sm font-medium text-danger">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            {evaluation.differenceIdr !== 0 && !hasAmountIssue
              ? t("accounting.manual.form.unbalanced")
              : t("form.invalid")}
          </span>
        )}
      </div>
    </div>
  );
}
