// Resolve form of the EDC reconciliation screen (bead legend-khi8n). Collects
// the outcome and the evidence, validates on blur and on submit with the
// messages next to the field, then opens the confirmation dialog. The gate
// from lib.ts decides what can be chosen: the server stays the checker, this
// only keeps a reviewer from sending a request it would refuse. Nothing is
// prefilled from the transaction, so the printed amount is always typed from
// the evidence rather than copied from the request.
import * as React from "react";
import { CircleAlert, Clock, Lock } from "lucide-react";
import { cn } from "cn";
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
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import { hasPanLengthDigits } from "@starter/shared/edc";
import type {
  EdcReconciliationEvidenceSource,
  EdcReconciliationOutcome,
} from "@starter/shared/edc";
import type { MessageKey } from "@starter/shared/i18n";
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";
import type { reconciliationGate } from "../lib";
import {
  ConfirmDialog,
  SOURCE_KEYS,
  type ResolveDraft,
} from "./confirm-dialog";

const P = "edcRecon.resolve";
const key = (suffix: string) => `${P}.${suffix}` as MessageKey;

export type ReconciliationGate = ReturnType<typeof reconciliationGate>;

const clockFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});
const momentFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});

/** "09.58" in the outlet zone (WIB). */
export function formatClock(ms: number): string {
  return clockFormat.format(new Date(ms));
}

/** "15 Nov 2026, 09.18 WIB". */
export function formatMomentWib(iso: string): string {
  return `${momentFormat.format(new Date(iso))} WIB`;
}

const SOURCES: readonly EdcReconciliationEvidenceSource[] = [
  "terminal_receipt",
  "inquiry",
  "bank_statement",
];
const OUTCOMES: readonly EdcReconciliationOutcome[] = ["approved", "declined"];
const NOTE_MAX = 500;

type FieldName =
  "outcome" | "source" | "amount" | "approvalCode" | "rrn" | "note";
type Errors = Partial<Record<FieldName, string>>;

type Values = {
  outcome: EdcReconciliationOutcome | "";
  source: EdcReconciliationEvidenceSource | "";
  amount: string;
  approvalCode: string;
  rrn: string;
  note: string;
};

const EMPTY: Values = {
  outcome: "",
  source: "terminal_receipt",
  amount: "",
  approvalCode: "",
  rrn: "",
  note: "",
};

export function ResolveForm({
  item,
  gate,
  onResolved,
}: {
  item: EdcReconciliationQueueItem;
  gate: ReconciliationGate;
  onResolved: () => void;
}) {
  const t = useT();
  const tx = item.transaction;
  const open = gate.kind === "open";
  const allowed: readonly EdcReconciliationOutcome[] = open
    ? gate.outcomes
    : [];
  const locked = gate.kind === "wire-open" || gate.kind === "too-early";

  const [values, setValues] = React.useState<Values>(EMPTY);
  // A single allowed outcome is the only possible choice: it counts as picked
  // until the reviewer picks, and follows the gate when it changes.
  const outcome: Values["outcome"] =
    values.outcome !== ""
      ? values.outcome
      : allowed.length === 1
        ? (allowed[0] ?? "")
        : "";
  const [touched, setTouched] = React.useState<
    Partial<Record<FieldName, true>>
  >({});
  const [submitted, setSubmitted] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<ResolveDraft | null>(null);
  const uid = React.useId();
  const formRef = React.useRef<HTMLFormElement>(null);
  const fieldId = (
    name: "source" | "amount" | "approvalCode" | "rrn" | "note",
  ) => `${uid}-${name}`;

  // The row can change under an open form (status, terminal call finished).
  // Keep what was typed, recompute what can be chosen, and say so. Opening of
  // the 10-minute window is just the clock and is not announced.
  const [seen, setSeen] = React.useState({
    status: tx.status,
    kind: gate.kind,
  });
  const [changed, setChanged] = React.useState(false);
  if (seen.status !== tx.status || seen.kind !== gate.kind) {
    const clockOnly =
      seen.status === tx.status &&
      seen.kind === "too-early" &&
      gate.kind === "open";
    setSeen({ status: tx.status, kind: gate.kind });
    if (!clockOnly) setChanged(true);
  }

  const errors = ((): Errors => {
    const out: Errors = {};
    if (!outcome) out.outcome = t(key("errors.outcomeRequired"));
    else if (open && !allowed.includes(outcome))
      out.outcome = t(key("errors.outcomeUnavailable"));
    if (!values.source) out.source = t(key("errors.sourceRequired"));
    if (outcome === "approved") {
      if (values.amount === "") out.amount = t(key("errors.amountRequired"));
      else if (!/^\d{1,12}$/.test(values.amount))
        out.amount = t(key("errors.amountInvalid"));
      else if (Number(values.amount) !== tx.amountIdr)
        out.amount = t(key("errors.amountMismatch"));
    }
    const code = values.approvalCode.trim();
    if (code && !/^[A-Za-z0-9]{1,12}$/.test(code))
      out.approvalCode = t(key("errors.approvalCodeInvalid"));
    const rrn = values.rrn.trim();
    if (rrn && (!/^[A-Za-z0-9]{1,24}$/.test(rrn) || hasPanLengthDigits(rrn)))
      out.rrn = t(key("errors.rrnInvalid"));
    const note = values.note.trim();
    if (!note) out.note = t(key("errors.noteRequired"));
    else if (note.length > NOTE_MAX) out.note = t(key("errors.noteTooLong"));
    else if (hasPanLengthDigits(note))
      out.note = t(key("errors.noteCardNumber"));
    return out;
  })();

  const shown = (name: FieldName): string | undefined =>
    submitted || touched[name] ? errors[name] : undefined;
  const set = <K extends keyof Values>(name: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [name]: value }));
  const blur = (name: FieldName) => () =>
    setTouched((current) => ({ ...current, [name]: true }));

  const focusFirstInvalid = () => {
    if (errors.outcome) {
      formRef.current
        ?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)')
        ?.focus();
      return;
    }
    for (const name of [
      "source",
      "amount",
      "approvalCode",
      "rrn",
      "note",
    ] as const) {
      if (errors[name]) {
        document.getElementById(fieldId(name))?.focus();
        return;
      }
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!open) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      focusFirstInvalid();
      return;
    }
    if (!outcome || !values.source) return;
    setDraft({
      outcome,
      source: values.source,
      chargedAmountIdr: outcome === "approved" ? Number(values.amount) : null,
      approvalCode: values.approvalCode,
      rrn: values.rrn,
      note: values.note,
    });
    setDialogOpen(true);
  };

  const disabled = !open;
  const hasErrors = submitted && Object.keys(errors).length > 0;
  const outcomeError = shown("outcome");

  return (
    <section
      aria-labelledby={`${uid}-title`}
      data-testid="edc-recon-form"
      className="grid content-start gap-4"
    >
      <div className="grid gap-1">
        <h4 id={`${uid}-title`} className="type-title">
          {t(key("form.title"))}
        </h4>
        <p className="text-sm text-muted-foreground">{t(key("form.intro"))}</p>
      </div>

      {changed && (
        <GateBand
          testId="edc-recon-status-changed"
          title={t(key("form.statusChangedTitle"))}
          body={t(key("form.statusChangedBody"))}
          icon={CircleAlert}
        />
      )}

      {gate.kind === "wire-open" && (
        <GateBand
          testId="edc-recon-gate-wire-open"
          title={t(key("gate.wireOpenTitle"))}
          body={t(key("gate.wireOpenBody"))}
          icon={Clock}
        />
      )}
      {gate.kind === "too-early" && (
        <GateBand
          testId="edc-recon-gate-too-early"
          title={t(key("gate.tooEarlyTitle"), {
            time: `${formatClock(gate.eligibleAtMs)} WIB`,
          })}
          body={t(key("gate.tooEarlyBody"))}
          icon={Clock}
        />
      )}
      {gate.kind === "not-eligible" && (
        <GateBand
          testId="edc-recon-gate-not-eligible"
          title={t(key("gate.notEligibleTitle"))}
          body={t(key("gate.notEligibleBody"))}
          icon={Lock}
        />
      )}

      {gate.kind !== "not-eligible" && (
        <form
          noValidate
          ref={formRef}
          onSubmit={submit}
          aria-label={t(key("form.title"))}
          className="grid gap-4"
        >
          <fieldset
            className="grid gap-2"
            disabled={disabled}
            aria-describedby={outcomeError ? `${uid}-outcome-error` : undefined}
          >
            <legend className="mb-1 text-sm font-medium">
              {t(key("form.outcomeLegend"))}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {OUTCOMES.map((option) => {
                const allowedHere = allowed.includes(option);
                const checked = outcome === option;
                return (
                  <label
                    key={option}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-field border-(length:--border-w) px-3 py-2 text-sm font-semibold",
                      checked
                        ? "border-primary bg-primary-tint text-primary"
                        : "border-input bg-background",
                      (disabled || !allowedHere) &&
                        "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${uid}-outcome`}
                      value={option}
                      checked={checked}
                      disabled={disabled || !allowedHere}
                      onChange={() => set("outcome", option)}
                      onBlur={blur("outcome")}
                      className="size-4 accent-primary"
                    />
                    {t(key(`outcomeWord.${option}`))}
                  </label>
                );
              })}
            </div>
            {open &&
              OUTCOMES.filter((option) => !allowed.includes(option)).map(
                (option) => (
                  <p
                    key={option}
                    className="text-sm text-muted-foreground"
                    data-testid="edc-recon-outcome-locked"
                  >
                    {t(key("form.outcomeLocked"), {
                      outcome: t(key(`outcomeWord.${option}`)),
                    })}
                  </p>
                ),
              )}
            <div id={`${uid}-outcome-error`} aria-live="polite">
              {outcomeError && (
                <p className="flex items-start gap-1.5 text-sm font-medium text-danger">
                  <CircleAlert
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  {outcomeError}
                </p>
              )}
            </div>
          </fieldset>

          <FormField
            id={fieldId("source")}
            label={t(key("form.sourceLabel"))}
            required
            error={shown("source")}
          >
            <Select
              value={values.source}
              disabled={disabled}
              onValueChange={(next) =>
                set("source", next as EdcReconciliationEvidenceSource)
              }
            >
              <SelectTrigger
                className="w-full"
                data-testid="edc-recon-source"
                onBlur={blur("source")}
              >
                <SelectValue placeholder={t(key("form.sourcePlaceholder"))} />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {t(key(SOURCE_KEYS[source]))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {outcome === "approved" && (
            <FormField
              id={fieldId("amount")}
              label={t(key("form.amountLabel"))}
              required
              hint={t(key("form.amountHint"))}
              error={shown("amount")}
            >
              <Input
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                disabled={disabled}
                value={values.amount}
                onChange={(event) =>
                  set("amount", event.target.value.replace(/\D/g, ""))
                }
                onBlur={blur("amount")}
                data-testid="edc-recon-amount"
                className="tabular"
              />
            </FormField>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id={fieldId("approvalCode")}
              label={t(key("form.approvalCodeLabel"))}
              error={shown("approvalCode")}
            >
              <Input
                autoComplete="off"
                maxLength={12}
                spellCheck={false}
                disabled={disabled}
                value={values.approvalCode}
                onChange={(event) => set("approvalCode", event.target.value)}
                onBlur={blur("approvalCode")}
                className="tabular"
              />
            </FormField>
            <FormField
              id={fieldId("rrn")}
              label={t(key("form.rrnLabel"))}
              error={shown("rrn")}
            >
              <Input
                autoComplete="off"
                maxLength={24}
                spellCheck={false}
                disabled={disabled}
                value={values.rrn}
                onChange={(event) => set("rrn", event.target.value)}
                onBlur={blur("rrn")}
                className="tabular"
              />
            </FormField>
          </div>

          <FormField
            id={fieldId("note")}
            label={t(key("form.noteLabel"))}
            required
            hint={t(key("form.noteHint"))}
            error={shown("note")}
          >
            <Textarea
              rows={4}
              maxLength={NOTE_MAX + 50}
              disabled={disabled}
              aria-describedby={[
                `${fieldId("note")}-hint`,
                shown("note") ? `${fieldId("note")}-error` : null,
                `${fieldId("note")}-count`,
              ]
                .filter(Boolean)
                .join(" ")}
              value={values.note}
              onChange={(event) => set("note", event.target.value)}
              onBlur={blur("note")}
              data-testid="edc-recon-note"
            />
          </FormField>
          <p
            id={`${fieldId("note")}-count`}
            className="-mt-2 text-right text-xs text-muted-foreground tabular"
          >
            <span className="sr-only">{t(key("form.noteCounter"))}: </span>
            {t(key("form.noteCount"), { count: values.note.trim().length })}
          </p>

          {hasErrors && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-sm font-medium text-danger"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t(key("errors.summary"))}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t-(length:--border-w) pt-4">
            <p className="max-w-56 text-sm text-muted-foreground">
              {t(key("form.nextHint"))}
            </p>
            <Button
              type="submit"
              className="min-h-11"
              disabled={disabled}
              data-testid="edc-recon-review"
            >
              {locked && <Lock aria-hidden="true" />}
              {locked ? t(key("gate.locked")) : t(key("form.review"))}
            </Button>
          </div>
        </form>
      )}

      {draft && (
        <ConfirmDialog
          item={item}
          draft={draft}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onResolved={onResolved}
        />
      )}
    </section>
  );
}

function GateBand({
  title,
  body,
  icon: Icon,
  testId,
}: {
  title: string;
  body: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  testId: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="grid gap-0.5 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground"
    >
      <p className="flex items-center gap-2 font-semibold">
        <Icon className="size-4 shrink-0" aria-hidden={true} />
        {title}
      </p>
      <p>{body}</p>
    </div>
  );
}
