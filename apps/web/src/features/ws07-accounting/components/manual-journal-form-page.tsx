// Manual journal form: create a draft or edit one that is draft/rejected.
// The line editor enforces ACC-01 while typing (balanced, one side per row,
// whole rupiah) and the date field says whether the fiscal period is open
// (ACC-02). Approval happens on the detail screen, by a different person.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ManualJournal } from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  useAccounts,
  useCreateManualJournal,
  useFiscalPeriods,
  useUpdateManualJournal,
} from "../hooks";
import {
  MANUAL_KIND_KEYS,
  businessDateToday,
  evaluateManualDraft,
  formatPeriod,
  postableAccounts,
} from "../lib";
import {
  JournalLinesEditor,
  blankEditorLine,
  type EditorLine,
} from "./lines-editor";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type Kind = ManualJournal["kind"];

function rowsFromJournal(journal: ManualJournal | undefined): EditorLine[] {
  if (!journal) return [blankEditorLine(), blankEditorLine()];
  return journal.lines.map((line) => ({
    key: newIdempotencyKey(),
    accountId: line.accountId,
    debit: line.debitIdr > 0 ? String(line.debitIdr) : "",
    credit: line.creditIdr > 0 ? String(line.creditIdr) : "",
  }));
}

export function ManualJournalFormPage({
  legalEntityId,
  entityName,
  journal,
}: {
  legalEntityId: string;
  entityName?: string;
  /** Present = edit mode (the row is draft or rejected). */
  journal?: ManualJournal;
}) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const accountsQuery = useAccounts(legalEntityId);
  const periodsQuery = useFiscalPeriods(legalEntityId);
  const create = useCreateManualJournal();
  const update = useUpdateManualJournal(journal?.id);

  const [entryDate, setEntryDate] = React.useState(
    journal?.entryDate ?? businessDateToday(),
  );
  const [kind, setKind] = React.useState<Kind>(journal?.kind ?? "general");
  const [description, setDescription] = React.useState(
    journal?.description ?? "",
  );
  const [rows, setRows] = React.useState<EditorLine[]>(() =>
    rowsFromJournal(journal),
  );
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [descriptionError, setDescriptionError] = React.useState<
    string | undefined
  >(undefined);

  const accounts = postableAccounts(accountsQuery.data ?? []);
  const evaluation = evaluateManualDraft(rows);
  const period = periodsQuery.data?.find(
    (row) => row.period === entryDate.slice(0, 7),
  );
  const periodClosed = period?.status === "closed";
  const pending = create.isPending || update.isPending;
  const canSubmit =
    evaluation.balanced &&
    description.trim() !== "" &&
    entryDate !== "" &&
    !periodClosed &&
    !pending;

  const submit = async () => {
    setServerError(null);
    if (description.trim() === "") {
      setDescriptionError(t("form.invalid"));
      return;
    }
    setDescriptionError(undefined);
    if (!evaluation.balanced) return;
    try {
      if (journal) {
        const next = await update.mutateAsync({
          entryDate,
          kind,
          description: description.trim(),
          lines: evaluation.lines,
        });
        toast({ title: t("accounting.manual.updated") });
        void navigate({
          to: "/kelola/akuntansi/jurnal-manual/$manualJournalId",
          params: { manualJournalId: next.id },
        });
        return;
      }
      const created = await create.mutateAsync({
        legalEntityId,
        outletId: null,
        entryDate,
        kind,
        description: description.trim(),
        lines: evaluation.lines,
      });
      toast({ title: t("accounting.manual.saved") });
      void navigate({
        to: "/kelola/akuntansi/jurnal-manual/$manualJournalId",
        params: { manualJournalId: created.id },
      });
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <div className="grid gap-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/kelola/akuntansi/jurnal-manual">
            <ArrowLeft aria-hidden="true" />
            {t("accounting.manual.detail.back")}
          </Link>
        </Button>
      </div>
      <header className="grid gap-1">
        <h2 className="type-title">
          {journal
            ? t("accounting.manual.form.titleEdit")
            : t("accounting.manual.form.titleNew")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {entityName ?? t("accounting.manual.subtitle")}
        </p>
      </header>
      <form
        className="grid gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t("accounting.manual.form.date")} required>
            <Input
              type="date"
              value={entryDate}
              onChange={(event) => setEntryDate(event.target.value)}
              className="tabular"
            />
          </FormField>
          <FormField label={t("accounting.manual.form.kind")} required>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as Kind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(
                    MANUAL_KIND_KEYS,
                  ) as (keyof typeof MANUAL_KIND_KEYS)[]
                ).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(MANUAL_KIND_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="grid content-start gap-1 pt-0 sm:pt-6">
            <p
              className={
                periodClosed
                  ? "text-sm leading-5 text-danger"
                  : "text-sm leading-5 text-muted-foreground"
              }
            >
              {period
                ? periodClosed
                  ? t("accounting.manual.form.periodClosed", {
                      period: formatPeriod(period.period),
                    })
                  : t("accounting.manual.form.periodOpen", {
                      period: formatPeriod(period.period),
                    })
                : t("accounting.manual.form.dateHint")}
            </p>
          </div>
        </div>
        <FormField
          label={t("accounting.manual.form.description")}
          hint={t("accounting.manual.form.descriptionHint")}
          error={descriptionError}
          required
        >
          <Textarea
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setDescriptionError(undefined);
            }}
            rows={2}
            maxLength={255}
          />
        </FormField>
        {accountsQuery.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="grid gap-2">
            <h3 className="text-base leading-6 font-semibold">
              {t("accounting.manual.form.lines")}
            </h3>
            <JournalLinesEditor
              accounts={accounts}
              rows={rows}
              onChange={setRows}
              evaluation={evaluation}
              disabled={pending}
            />
          </div>
        )}
        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <Button asChild variant="outline" type="button">
            <Link to="/kelola/akuntansi/jurnal-manual">
              {t("common.cancel")}
            </Link>
          </Button>
          <Button type="submit" loading={pending} disabled={!canSubmit}>
            {journal
              ? t("accounting.manual.form.saveChanges")
              : t("accounting.manual.form.saveDraft")}
          </Button>
        </div>
      </form>
    </div>
  );
}
