// Create a recurring journal template (PRD v1.7 §3.19 "Jurnal Berulang"): a
// monthly template approved once, then generated per period. The lines follow
// the same ACC-01 rules as a manual journal; the day clamps to the month's
// last day in the contract.
import * as React from "react";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useCreateRecurringJournal } from "../hooks";
import { businessDateToday, evaluateManualDraft } from "../lib";
import { blankEditorLine, type EditorLine } from "./lines-editor";
import { JournalLinesSection } from "./journal-lines-section";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function RecurringJournalDialog({
  open,
  onOpenChange,
  legalEntityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
}) {
  // Radix unmounts DialogContent on close, so the form re-mounts with empty
  // fields on every opening — no effect resetting state.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <RecurringJournalForm
          onOpenChange={onOpenChange}
          legalEntityId={legalEntityId}
        />
      </DialogContent>
    </Dialog>
  );
}

function RecurringJournalForm({
  onOpenChange,
  legalEntityId,
}: {
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateRecurringJournal(legalEntityId);

  const [description, setDescription] = React.useState("");
  const [day, setDay] = React.useState("31");
  const [startPeriod, setStartPeriod] = React.useState(() =>
    businessDateToday().slice(0, 7),
  );
  const [endPeriod, setEndPeriod] = React.useState("");
  const [rows, setRows] = React.useState<EditorLine[]>(() => [
    blankEditorLine(),
    blankEditorLine(),
  ]);
  const [errors, setErrors] = React.useState<{
    description?: string;
    day?: string;
    period?: string;
    server?: string;
  }>({});

  const evaluation = evaluateManualDraft(rows);
  const dayNumber = Number(day);
  const canSubmit =
    description.trim() !== "" &&
    Number.isInteger(dayNumber) &&
    dayNumber >= 1 &&
    dayNumber <= 31 &&
    PERIOD_PATTERN.test(startPeriod) &&
    (endPeriod === "" || PERIOD_PATTERN.test(endPeriod)) &&
    (endPeriod === "" || endPeriod >= startPeriod) &&
    evaluation.balanced &&
    !create.isPending;

  const submit = async () => {
    const nextErrors: typeof errors = {};
    if (description.trim() === "") nextErrors.description = t("form.invalid");
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31)
      nextErrors.day = t("accounting.recurring.form.invalidDay");
    if (!PERIOD_PATTERN.test(startPeriod))
      nextErrors.period = t("form.invalid");
    else if (endPeriod !== "" && endPeriod < startPeriod)
      nextErrors.period = t("accounting.recurring.form.invalidPeriod");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await create.mutateAsync({
        legalEntityId,
        outletId: null,
        description: description.trim(),
        lines: evaluation.lines,
        dayOfMonth: dayNumber,
        startPeriod,
        endPeriod: endPeriod === "" ? null : endPeriod,
      });
      toast({ title: t("accounting.recurring.created") });
      onOpenChange(false);
    } catch (error) {
      setErrors({
        server:
          error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.recurring.form.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.recurring.subtitle")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("accounting.recurring.form.description")}
          error={errors.description}
          required
        >
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            maxLength={255}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label={t("accounting.recurring.form.day")}
            hint={t("accounting.recurring.form.dayHint")}
            error={errors.day}
            required
          >
            <Input
              type="number"
              min={1}
              max={31}
              value={day}
              onChange={(event) => setDay(event.target.value)}
              inputMode="numeric"
              className="tabular"
            />
          </FormField>
          <FormField
            label={t("accounting.recurring.form.start")}
            error={errors.period}
            required
          >
            <Input
              type="month"
              value={startPeriod}
              onChange={(event) => setStartPeriod(event.target.value)}
              className="tabular"
            />
          </FormField>
          <FormField
            label={t("accounting.recurring.form.end")}
            hint={t("accounting.recurring.form.endHint")}
          >
            <Input
              type="month"
              value={endPeriod}
              onChange={(event) => setEndPeriod(event.target.value)}
              className="tabular"
            />
          </FormField>
        </div>
        <JournalLinesSection
          legalEntityId={legalEntityId}
          heading={t("accounting.recurring.form.lines")}
          rows={rows}
          onChange={setRows}
          evaluation={evaluation}
          disabled={create.isPending}
        />
        {errors.server && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {errors.server}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={!canSubmit}
          >
            {t("accounting.recurring.form.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
