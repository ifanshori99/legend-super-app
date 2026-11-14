// Filter bar: kind, outlet and the business-date window. Edits stay local
// until "Terapkan filter" (the URL carries the applied filters; the parent
// remounts this form with a new key when they change from outside). The window
// is checked here with the API's own rules; the server still has the last word.
import * as React from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FINANCE_EXCEPTION_KINDS,
  FINANCE_EXCEPTIONS_MAX_DAYS,
  KIND_LABEL_KEYS,
  RANGE_ERROR_KEYS,
  isFinanceExceptionKind,
  validateRange,
  type FinanceExceptionFilters,
} from "../lib";

const ALL = "all";

/** What the form holds right now, applied or not (kind lives in `applied`). */
export type FilterDraft = { outletId?: string; from: string; to: string };

/** Label + select without the "(opsional)" suffix of FormField: "all" is a choice. */
function SelectField({
  label,
  children,
}: {
  label: string;
  children: (ids: { id: string; labelId: string }) => React.ReactNode;
}) {
  const base = React.useId();
  const id = `${base}-control`;
  const labelId = `${base}-label`;
  return (
    <div className="grid gap-1.5">
      <Label id={labelId} htmlFor={id}>
        {label}
      </Label>
      {children({ id, labelId })}
    </div>
  );
}

export function ExceptionsFilters({
  applied,
  outlets,
  outletsLoading,
  draftRef,
  onApply,
  onReset,
}: {
  applied: FinanceExceptionFilters;
  outlets: readonly { id: string; name: string }[];
  outletsLoading: boolean;
  /** Mirrors the unapplied edits so a summary-card click can keep them. */
  draftRef: React.MutableRefObject<FilterDraft | null>;
  onApply: (filters: FinanceExceptionFilters) => void;
  onReset: () => void;
}) {
  const t = useT();
  const [kind, setKind] = React.useState<string>(applied.kind ?? ALL);
  const [outletId, setOutletId] = React.useState<string>(
    applied.outletId ?? ALL,
  );
  const [from, setFrom] = React.useState(applied.from);
  const [to, setTo] = React.useState(applied.to);

  React.useEffect(() => {
    draftRef.current = {
      ...(outletId !== ALL ? { outletId } : {}),
      from,
      to,
    };
  }, [draftRef, outletId, from, to]);

  const rangeError = validateRange(from, to);
  const error = rangeError
    ? t(RANGE_ERROR_KEYS[rangeError], { days: FINANCE_EXCEPTIONS_MAX_DAYS })
    : undefined;

  return (
    <form
      aria-label={t("financeExceptions.filters.label")}
      // Read-only form: allowed in a read-only support session.
      data-support-readonly-allow
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (rangeError) return;
        onApply({
          ...(isFinanceExceptionKind(kind) ? { kind } : {}),
          ...(outletId !== ALL ? { outletId } : {}),
          from,
          to,
        });
      }}
      className="grid min-w-0 gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline"
    >
      <div className="grid items-start gap-3 min-[700px]:grid-cols-2 lg:grid-cols-[1.2fr_1fr_0.8fr_0.8fr_auto]">
        <SelectField label={t("financeExceptions.filters.kind")}>
          {({ id, labelId }) => (
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id={id} aria-labelledby={labelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("financeExceptions.filters.kindAll")}
                </SelectItem>
                {FINANCE_EXCEPTION_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(KIND_LABEL_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SelectField>
        <SelectField label={t("financeExceptions.filters.outlet")}>
          {({ id, labelId }) => (
            <Select value={outletId} onValueChange={setOutletId}>
              <SelectTrigger id={id} aria-labelledby={labelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {outletsLoading
                    ? t("financeExceptions.filters.outletLoading")
                    : t("financeExceptions.filters.outletAll")}
                </SelectItem>
                {outlets.map((outlet) => (
                  <SelectItem key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SelectField>
        <FormField label={t("financeExceptions.filters.from")} required>
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="tabular"
          />
        </FormField>
        <FormField
          label={t("financeExceptions.filters.to")}
          required
          {...(error ? { error } : {})}
        >
          <Input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="tabular"
          />
        </FormField>
        <Button
          type="submit"
          allowInReadOnly
          disabled={rangeError !== null}
          className="w-full max-lg:min-h-11 lg:mt-[1.625rem] lg:w-auto"
        >
          {t("financeExceptions.filters.apply")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3 text-sm text-muted-foreground">
        <p>
          {t("financeExceptions.filters.hint", {
            days: FINANCE_EXCEPTIONS_MAX_DAYS,
          })}
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onReset}
          className="max-sm:min-h-11"
        >
          {t("financeExceptions.filters.reset")}
        </Button>
      </div>
      <p className="flex items-start gap-2 rounded-control bg-info-subtle px-3 py-2.5 text-sm leading-5 text-foreground">
        <Info
          className="mt-0.5 size-icon shrink-0 text-info"
          aria-hidden="true"
        />
        {t("financeExceptions.payoutNote")}
      </p>
    </form>
  );
}
