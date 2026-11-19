// Filters of the audit log (PRD §3 F36): actor kind, module, action, outlet and
// a date range. A real form: Enter applies, every control is reachable by
// keyboard, and a bad value says how to fix it (PRD: error + petunjuk).
import { cn } from "cn";
import { CircleAlert, Filter } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { cafeLegendCoreSample } from "@starter/shared/core/sample";
import type { AuditActorType } from "@starter/shared/audit";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACTOR_LABEL_KEYS, objectTypeLabel } from "../labels";
import {
  ACTOR_TYPES,
  EMPTY_FILTERS,
  MODULES,
  activeFilterCount,
  filterIssues,
  type AuditFilters,
} from "../lib";

const ALL = "__all";

export type OutletOption = { id: string; name: string };

/** Outlets of the demo tenant; the real list comes with the outlet context. */
export const MOCK_OUTLET_OPTIONS: readonly OutletOption[] =
  cafeLegendCoreSample.outlets.map((outlet) => ({
    id: outlet.id,
    name: outlet.name,
  }));

type ControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

/** Label + control + hint/error. Filters are all optional: no "(opsional)" suffix. */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {hint && (
        <p
          id={`${id}-hint`}
          className="text-sm leading-5 text-muted-foreground"
        >
          {hint}
        </p>
      )}
      <div aria-live="polite">
        {error && (
          <p
            id={`${id}-error`}
            className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function OptionSelect({
  control,
  value,
  onChange,
  options,
  allLabel,
}: {
  control: ControlProps;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <Select
      value={value === "" ? ALL : value}
      onValueChange={(next) => onChange(next === ALL ? "" : next)}
    >
      <SelectTrigger {...control}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AuditFilterBar({
  applied,
  outlets,
  onApply,
}: {
  applied: AuditFilters;
  outlets: readonly OutletOption[];
  onApply: (filters: AuditFilters) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(applied);
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const issues = submitted ? filterIssues(draft) : [];
  const count = activeFilterCount(applied);
  const all = t("auditSettings.audit.filters.all");
  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (filterIssues(draft).length > 0) return;
    onApply({ ...draft, action: draft.action.trim() });
  }

  function reset() {
    setDraft(EMPTY_FILTERS);
    setSubmitted(false);
    onApply(EMPTY_FILTERS);
  }

  return (
    <CardShell>
      <CardShellBody>
        <form
          onSubmit={submit}
          aria-label={t("auditSettings.audit.filters.label")}
          className="grid gap-4 p-4"
          noValidate
        >
          <div className="flex items-center justify-between gap-2 lg:hidden">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-controls="audit-filter-fields"
              onClick={() => setOpen((value) => !value)}
            >
              <Filter aria-hidden="true" />
              {t("auditSettings.audit.filters.label")}
            </Button>
            {count > 0 && (
              <span className="text-sm text-muted-foreground tabular">
                {t("auditSettings.audit.filters.active", { count })}
              </span>
            )}
          </div>
          <div
            id="audit-filter-fields"
            className={cn(
              "grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 lg:grid-cols-3",
              open ? "grid" : "hidden lg:grid",
            )}
          >
            <Field label={t("auditSettings.audit.filters.actorType")}>
              {(control) => (
                <OptionSelect
                  control={control}
                  value={draft.actorType}
                  onChange={(value) =>
                    set("actorType", value as AuditActorType | "")
                  }
                  options={ACTOR_TYPES.map((type) => ({
                    value: type,
                    label: t(ACTOR_LABEL_KEYS[type]),
                  }))}
                  allLabel={all}
                />
              )}
            </Field>
            <Field label={t("auditSettings.audit.filters.module")}>
              {(control) => (
                <OptionSelect
                  control={control}
                  value={draft.objectType}
                  onChange={(value) => set("objectType", value)}
                  options={MODULES.map((module) => ({
                    value: module,
                    label: objectTypeLabel(t, module),
                  }))}
                  allLabel={all}
                />
              )}
            </Field>
            <Field label={t("auditSettings.audit.filters.outlet")}>
              {(control) => (
                <OptionSelect
                  control={control}
                  value={draft.outletId}
                  onChange={(value) => set("outletId", value)}
                  options={outlets.map((outlet) => ({
                    value: outlet.id,
                    label: outlet.name,
                  }))}
                  allLabel={all}
                />
              )}
            </Field>
            <Field
              label={t("auditSettings.audit.filters.action")}
              hint={t("auditSettings.audit.filters.actionHint")}
              error={
                issues.includes("invalidAction")
                  ? t("auditSettings.audit.filters.invalidAction")
                  : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={draft.action}
                  onChange={(event) => set("action", event.target.value)}
                  placeholder={t(
                    "auditSettings.audit.filters.actionPlaceholder",
                  )}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label={t("auditSettings.audit.filters.from")}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={draft.from}
                  max={draft.to || undefined}
                  onChange={(event) => set("from", event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t("auditSettings.audit.filters.to")}
              error={
                issues.includes("invalidRange")
                  ? t("auditSettings.audit.filters.invalidRange")
                  : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) => set("to", event.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit" size="sm">
                {t("auditSettings.audit.filters.apply")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={reset}>
                {t("auditSettings.audit.filters.reset")}
              </Button>
            </div>
          </div>
        </form>
      </CardShellBody>
    </CardShell>
  );
}
