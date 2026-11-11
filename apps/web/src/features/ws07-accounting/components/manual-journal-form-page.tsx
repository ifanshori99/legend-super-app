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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  useCreateManualJournal,
  useFiscalPeriods,
  useUpdateManualJournal,
} from "../hooks";
import {
  MANUAL_KIND_KEYS,
  businessDateToday,
  evaluateManualDraft,
  formatPeriod,
} from "../lib";
import {
  blankEditorLine,
  focusJournalProblem,
  type EditorLine,
} from "./lines-editor";
import { JournalLinesSection } from "./journal-lines-section";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type Kind = ManualJournal["kind"];

function rowsFromJournal(journal: ManualJournal | undefined): EditorLine[] {
  if (!journal) return [blankEditorLine(), blankEditorLine()];
  return journal.lines.map((line) => ({
    key: newIdempotencyKey(),
    accountId: line.accountId,
    outletId: line.outletId ?? "",
    costCenter: line.costCenter,
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

  const evaluation = evaluateManualDraft(rows);
  const period = periodsQuery.data?.find(
    (row) => row.period === entryDate.slice(0, 7),
  );
  const periodClosed = period?.status === "closed";
  const pending = create.isPending || update.isPending;
  const formRef = React.useRef<HTMLFormElement>(null);
  const [submitted, setSubmitted] = React.useState(false);
  // Simpan draf stays enabled so a click explains what is missing; the
  // validation in submit() keeps an invalid or unbalanced journal from the API.
  const canSubmit = !pending && !periodClosed;

  const submit = async () => {
    setServerError(null);
    setSubmitted(true);
    const missingDescription = description.trim() === "";
    setDescriptionError(missingDescription ? t("form.invalid") : undefined);
    if (
      missingDescription ||
      entryDate === "" ||
      periodClosed ||
      !evaluation.balanced
    ) {
      focusJournalProblem(formRef.current);
      return;
    }
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
        ref={formRef}
        noValidate
        className="grid gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label={t("accounting.manual.form.date")}
            error={
              entryDate === "" && submitted ? t("form.invalid") : undefined
            }
            required
          >
            <Input
              type="date"
              value={entryDate}
              onChange={(event) => setEntryDate(event.target.value)}
              aria-invalid={periodClosed ? true : undefined}
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
        <JournalLinesSection
          legalEntityId={legalEntityId}
          heading={t("accounting.manual.form.lines")}
          rows={rows}
          onChange={setRows}
          evaluation={evaluation}
          submitted={submitted}
          disabled={pending}
        />
        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}
        {periodClosed && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {t("accounting.manual.form.periodClosedSave")}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button
            asChild
            variant="outline"
            type="button"
            className="w-full sm:w-auto"
          >
            <Link to="/kelola/akuntansi/jurnal-manual">
              {t("common.cancel")}
            </Link>
          </Button>
          <Button
            type="submit"
            loading={pending}
            disabled={!canSubmit}
            className="w-full sm:w-auto"
          >
            {journal
              ? t("accounting.manual.form.saveChanges")
              : t("accounting.manual.form.saveDraft")}
          </Button>
        </div>
      </form>
    </div>
  );
}
