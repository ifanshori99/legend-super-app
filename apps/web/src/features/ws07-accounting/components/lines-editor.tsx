// Line editor for manual and recurring journals. It is the only place a user
// enters amounts, so the ACC-01 rules are visible while typing: exactly one
// side per row, whole rupiah, at least two rows, totals equal. Validation text
// comes from the catalog; the contract (evaluateManualDraft) decides.
import * as React from "react";
import { CircleAlert, CircleCheck, Plus, Trash2 } from "lucide-react";
import type { Account } from "@starter/shared/accounting";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountLabel, type DraftEvaluation } from "../lib";

export type EditorLine = {
  /** Stable React key; regenerated per row. */
  key: string;
  /** "" = not chosen yet (Radix shows the placeholder). */
  accountId: string;
  /** Raw text so the user may type "1.520.000". */
  debit: string;
  credit: string;
};

export function blankEditorLine(): EditorLine {
  return { key: crypto.randomUUID(), accountId: "", debit: "", credit: "" };
}

export function JournalLinesEditor({
  accounts,
  rows,
  onChange,
  evaluation,
  disabled = false,
}: {
  accounts: readonly Account[];
  rows: readonly EditorLine[];
  onChange: (rows: EditorLine[]) => void;
  evaluation: DraftEvaluation;
  disabled?: boolean;
}) {
  const t = useT();
  // Field ids come from useId + row position, not the random row key, so the
  // server render and hydration agree on every id/htmlFor pair.
  const baseId = React.useId();

  const update = (index: number, patch: Partial<EditorLine>) => {
    onChange(
      rows.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const issueFor = (index: number): string | undefined => {
    switch (evaluation.lineIssues[index]) {
      case "amount":
        return t("accounting.manual.form.amountInvalid");
      case "side":
        return t("accounting.manual.form.lineSide");
      case "account":
        return t("accounting.manual.form.accountRequired");
      default:
        return undefined;
    }
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div
        aria-hidden="true"
        className="hidden gap-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem]"
      >
        <span>{t("accounting.journal.columns.account")}</span>
        <span>{t("accounting.journal.columns.debit")}</span>
        <span>{t("accounting.journal.columns.credit")}</span>
        <span className="sr-only">{t("common.delete")}</span>
      </div>
      {rows.map((row, index) => {
        const line = index + 1;
        const issue = issueFor(index);
        return (
          <div
            key={row.key}
            className="grid min-w-0 gap-2 rounded-lg border-(length:--border-w) border-border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem] sm:items-start"
          >
            <div className="grid gap-1">
              <Label
                htmlFor={`${baseId}-line-${index}-account`}
                className="sm:sr-only"
              >
                {t("accounting.manual.form.account", { line })}
              </Label>
              <Select
                value={row.accountId}
                onValueChange={(accountId) => update(index, { accountId })}
                disabled={disabled}
              >
                <SelectTrigger
                  id={`${baseId}-line-${index}-account`}
                  className="h-control-sm"
                  aria-invalid={issue === undefined ? undefined : true}
                >
                  <SelectValue
                    placeholder={t("accounting.manual.form.accountPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label
                htmlFor={`${baseId}-line-${index}-debit`}
                className="sm:sr-only"
              >
                {t("accounting.manual.form.debit", { line })}
              </Label>
              <Input
                id={`${baseId}-line-${index}-debit`}
                value={row.debit}
                onChange={(event) =>
                  update(index, { debit: event.target.value })
                }
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                className="h-control-sm tabular"
                aria-invalid={issue === undefined ? undefined : true}
                disabled={disabled}
              />
            </div>
            <div className="grid gap-1">
              <Label
                htmlFor={`${baseId}-line-${index}-credit`}
                className="sm:sr-only"
              >
                {t("accounting.manual.form.credit", { line })}
              </Label>
              <Input
                id={`${baseId}-line-${index}-credit`}
                value={row.credit}
                onChange={(event) =>
                  update(index, { credit: event.target.value })
                }
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                className="h-control-sm tabular"
                aria-invalid={issue === undefined ? undefined : true}
                disabled={disabled}
              />
            </div>
            <div className="flex justify-end sm:pt-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("accounting.manual.form.removeLine", { line })}
                disabled={disabled || rows.length <= 2}
                onClick={() =>
                  onChange(rows.filter((_, position) => position !== index))
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {issue && (
              <p className="flex items-center gap-1 text-sm leading-5 text-danger sm:col-span-3">
                <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                {issue}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, blankEditorLine()])}
        >
          <Plus aria-hidden="true" />
          {t("accounting.manual.form.addLine")}
        </Button>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("accounting.manual.form.amountHint")}
      </p>
      <div
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border-(length:--border-w) border-border bg-muted p-card"
      >
        <p className="text-sm tabular">
          {t("accounting.manual.form.balance", {
            debit: formatRupiah(evaluation.debitIdr),
            credit: formatRupiah(evaluation.creditIdr),
          })}
        </p>
        {evaluation.balanced ? (
          <Badge tone="success">
            <CircleCheck aria-hidden="true" />
            {t("accounting.manual.form.balanced")}
          </Badge>
        ) : evaluation.filled < 2 ? (
          // Nothing entered yet: a hint, not an error.
          <p className="text-sm text-muted-foreground">
            {t("accounting.manual.form.linesRequired")}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium text-danger">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            {evaluation.differenceIdr !== 0
              ? t("accounting.manual.form.difference", {
                  amount: formatRupiah(Math.abs(evaluation.differenceIdr)),
                })
              : t("form.invalid")}
          </p>
        )}
      </div>
    </div>
  );
}
