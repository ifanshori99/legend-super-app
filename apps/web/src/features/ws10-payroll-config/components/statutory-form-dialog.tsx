// Draft editor for a statutory table version (PAYR-02): BPJS/PTKP/TER/PPh 21
// annual/overtime/THR parameters are data, so this dialog edits every table
// type without hard-coding a rate. A published version is never edited: a new
// draft starts from the latest version of the same type, and publishing is a
// separate confirmed step in the statutory tab.
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { businessDateSchema } from "@starter/shared/core";
import type { RoundingMode } from "@starter/shared/core";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type {
  JkkRiskClass,
  OvertimeDayType,
  PtkpStatus,
  StatutoryTableType,
  StatutoryTableVersion,
  TerCategory,
} from "@starter/shared/hris/payroll";
import {
  JKK_RISK_CLASSES,
  OVERTIME_DAY_TYPES,
  STATUTORY_TABLE_TYPES,
  TER_CATEGORIES,
  statutoryTableDraftInputSchema,
} from "@starter/shared/hris/payroll";
import { newIdempotencyKey } from "@/lib/idempotency";
import { payrollMutationError } from "../errors";
import { useCreateStatutoryDraft, useUpdateStatutoryDraft } from "../hooks";
import {
  JKK_RISK_KEYS,
  PTKP_STATUS_LIST,
  ROUNDING_KEYS,
  STATUTORY_TYPE_KEYS,
  draftOfVersion,
  formatMultiplierInput,
  formatRateInput,
  formatRupiahInput,
  maskRupiahTyping,
  parseMultiplierInput,
  parseRatePercent,
  parseRupiahInput,
  suggestStatutoryEffectiveFrom,
  versionsOfType,
} from "../lib";

// ---- Form model (strings in, contract draft out) --------------------------

type BracketForm = { upToIdr: string; rateBp: string };
type TierForm = { toHour: string; multiplier: string };

type FormState =
  | {
      type: "bpjs_kes" | "jht" | "jkm" | "jp";
      employerRate: string;
      employeeRate: string;
      wageCap: string;
      wageFloor: string;
      roundingMode: RoundingMode;
    }
  | {
      type: "jkk";
      riskRates: Record<JkkRiskClass, string>;
      employeeRate: string;
      wageCap: string;
      wageFloor: string;
      roundingMode: RoundingMode;
    }
  | { type: "ptkp"; amounts: Record<PtkpStatus, string> }
  | {
      type: "pph21_ter";
      categories: Record<PtkpStatus, TerCategory>;
      brackets: Record<TerCategory, BracketForm[]>;
      roundingMode: RoundingMode;
    }
  | {
      type: "pph21_annual";
      brackets: BracketForm[];
      occupationalRate: string;
      occupationalCap: string;
      roundDownTo: string;
      noTaxIdSurcharge: string;
      roundingMode: RoundingMode;
    }
  | {
      type: "overtime";
      divisor: string;
      tiers: Record<OvertimeDayType, TierForm[]>;
      roundingMode: RoundingMode;
    }
  | {
      type: "thr";
      minTenure: string;
      fullTenure: string;
      roundingMode: RoundingMode;
    };

const OVERTIME_TYPES: readonly StatutoryTableType[] = STATUTORY_TABLE_TYPES;

function bracketsToForm(rows: readonly { upToIdr: number | null; rateBp: number }[]): BracketForm[] {
  return rows.map((row) => ({
    upToIdr: formatRupiahInput(row.upToIdr),
    rateBp: formatRateInput(row.rateBp),
  }));
}

function tiersToForm(
  rows: readonly { toHour: number | null; multiplier: string }[],
): TierForm[] {
  return rows.map((row) => ({
    toHour: row.toHour === null ? "" : String(row.toHour),
    multiplier: formatMultiplierInput(row.multiplier),
  }));
}

function formFromDraft(draft: ReturnType<typeof draftOfVersion>): FormState {
  switch (draft.type) {
    case "bpjs_kes":
    case "jht":
    case "jkm":
    case "jp": {
      const p = draft.parameters;
      return {
        type: draft.type,
        employerRate: formatRateInput(p.employerRateBp),
        employeeRate: formatRateInput(p.employeeRateBp),
        wageCap: formatRupiahInput(p.wageCapIdr),
        wageFloor: formatRupiahInput(p.wageFloorIdr),
        roundingMode: p.roundingMode,
      };
    }
    case "jkk": {
      const p = draft.parameters;
      return {
        type: "jkk",
        riskRates: Object.fromEntries(
          JKK_RISK_CLASSES.map((riskClass) => [
            riskClass,
            formatRateInput(p.employerRateBpByRiskClass[riskClass]),
          ]),
        ) as Record<JkkRiskClass, string>,
        employeeRate: formatRateInput(p.employeeRateBp),
        wageCap: formatRupiahInput(p.wageCapIdr),
        wageFloor: formatRupiahInput(p.wageFloorIdr),
        roundingMode: p.roundingMode,
      };
    }
    case "ptkp": {
      const p = draft.parameters;
      return {
        type: "ptkp",
        amounts: Object.fromEntries(
          PTKP_STATUS_LIST.map((status) => [
            status,
            formatRupiahInput(p.annualAmountIdrByStatus[status]),
          ]),
        ) as Record<PtkpStatus, string>,
      };
    }
    case "pph21_ter": {
      const p = draft.parameters;
      return {
        type: "pph21_ter",
        categories: { ...p.categoryByPtkpStatus },
        brackets: {
          A: bracketsToForm(p.bracketsByCategory.A),
          B: bracketsToForm(p.bracketsByCategory.B),
          C: bracketsToForm(p.bracketsByCategory.C),
        },
        roundingMode: p.roundingMode,
      };
    }
    case "pph21_annual": {
      const p = draft.parameters;
      return {
        type: "pph21_annual",
        brackets: bracketsToForm(p.brackets),
        occupationalRate: formatRateInput(p.occupationalCostRateBp),
        occupationalCap: formatRupiahInput(p.occupationalCostAnnualCapIdr),
        roundDownTo: formatRupiahInput(p.taxableIncomeRoundDownToIdr),
        noTaxIdSurcharge: formatRateInput(p.noTaxIdSurchargeBp),
        roundingMode: p.roundingMode,
      };
    }
    case "overtime": {
      const p = draft.parameters;
      return {
        type: "overtime",
        divisor: String(p.monthlyHoursDivisor),
        tiers: {
          workday: tiersToForm(p.tiersByDayType.workday),
          rest_day_6_day_week: tiersToForm(p.tiersByDayType.rest_day_6_day_week),
          rest_day_5_day_week: tiersToForm(p.tiersByDayType.rest_day_5_day_week),
        },
        roundingMode: p.roundingMode,
      };
    }
    case "thr": {
      const p = draft.parameters;
      return {
        type: "thr",
        minTenure: String(p.minTenureMonths),
        fullTenure: String(p.fullTenureMonths),
        roundingMode: p.roundingMode,
      };
    }
  }
}

function optionalAmount(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = parseRupiahInput(text);
  return value === null ? undefined : value;
}

function requiredAmount(text: string): number | undefined {
  const value = parseRupiahInput(text);
  return value === null ? undefined : value;
}

function requiredCount(
  text: string,
  min: number,
  max: number,
): number | undefined {
  if (!/^\d{1,3}$/.test(text.trim())) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

function bracketsFromForm(rows: BracketForm[]) {
  const out: { upToIdr: number | null; rateBp: number }[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const last = index === rows.length - 1;
    const rateBp = parseRatePercent(rows[index].rateBp);
    if (rateBp === null) return null;
    if (last) {
      out.push({ upToIdr: null, rateBp });
      continue;
    }
    const upToIdr = parseRupiahInput(rows[index].upToIdr);
    if (upToIdr === null) return null;
    out.push({ upToIdr, rateBp });
  }
  return out;
}

function tiersFromForm(rows: TierForm[]) {
  const out: {
    fromHour: number;
    toHour: number | null;
    multiplier: string;
  }[] = [];
  let fromHour = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const last = index === rows.length - 1;
    const multiplier = parseMultiplierInput(rows[index].multiplier);
    if (multiplier === null) return null;
    if (last) {
      out.push({ fromHour, toHour: null, multiplier });
      continue;
    }
    const toHour = requiredCount(rows[index].toHour, 1, 24);
    if (toHour === undefined || toHour <= fromHour) return null;
    out.push({ fromHour, toHour, multiplier });
    fromHour = toHour;
  }
  return out;
}

/** The contract draft (plain JSON); the schema brands and validates it. */
function buildDraft(form: FormState): unknown {
  switch (form.type) {
    case "bpjs_kes":
    case "jht":
    case "jkm":
    case "jp": {
      const employer = parseRatePercent(form.employerRate);
      const employee = parseRatePercent(form.employeeRate);
      const cap = optionalAmount(form.wageCap);
      const floor = optionalAmount(form.wageFloor);
      if (employer === null || employee === null) return null;
      if (cap === undefined || floor === undefined) return null;
      return {
        type: form.type,
        parameters: {
          employerRateBp: employer,
          employeeRateBp: employee,
          wageCapIdr: cap,
          wageFloorIdr: floor,
          roundingMode: form.roundingMode,
        },
      };
    }
    case "jkk": {
      const rates: Record<string, number> = {};
      for (const riskClass of JKK_RISK_CLASSES) {
        const rate = parseRatePercent(form.riskRates[riskClass]);
        if (rate === null) return null;
        rates[riskClass] = rate;
      }
      const employee = parseRatePercent(form.employeeRate);
      const cap = optionalAmount(form.wageCap);
      const floor = optionalAmount(form.wageFloor);
      if (employee === null || cap === undefined || floor === undefined)
        return null;
      return {
        type: "jkk",
        parameters: {
          employerRateBpByRiskClass: rates,
          employeeRateBp: employee,
          wageCapIdr: cap,
          wageFloorIdr: floor,
          roundingMode: form.roundingMode,
        },
      };
    }
    case "ptkp": {
      const amounts: Record<string, number> = {};
      for (const status of PTKP_STATUS_LIST) {
        const amount = requiredAmount(form.amounts[status]);
        if (amount === undefined) return null;
        amounts[status] = amount;
      }
      return { type: "ptkp", parameters: { annualAmountIdrByStatus: amounts } };
    }
    case "pph21_ter": {
      const brackets: Record<TerCategory, unknown> = { A: null, B: null, C: null };
      for (const category of TER_CATEGORIES) {
        const rows = bracketsFromForm(form.brackets[category]);
        if (rows === null) return null;
        brackets[category] = rows;
      }
      return {
        type: "pph21_ter",
        parameters: {
          categoryByPtkpStatus: form.categories,
          bracketsByCategory: brackets,
          roundingMode: form.roundingMode,
        },
      };
    }
    case "pph21_annual": {
      const brackets = bracketsFromForm(form.brackets);
      const occupationalRate = parseRatePercent(form.occupationalRate);
      const occupationalCap = requiredAmount(form.occupationalCap);
      const roundDownTo = requiredAmount(form.roundDownTo);
      const noTaxIdSurcharge =
        form.noTaxIdSurcharge.trim() === ""
          ? null
          : parseRatePercent(form.noTaxIdSurcharge);
      if (
        brackets === null ||
        occupationalRate === null ||
        occupationalCap === undefined ||
        roundDownTo === undefined ||
        noTaxIdSurcharge === undefined
      )
        return null;
      return {
        type: "pph21_annual",
        parameters: {
          brackets,
          occupationalCostRateBp: occupationalRate,
          occupationalCostAnnualCapIdr: occupationalCap,
          taxableIncomeRoundDownToIdr: roundDownTo,
          noTaxIdSurchargeBp: noTaxIdSurcharge,
          roundingMode: form.roundingMode,
        },
      };
    }
    case "overtime": {
      const tiers: Record<string, unknown> = {};
      for (const dayType of OVERTIME_DAY_TYPES) {
        const rows = tiersFromForm(form.tiers[dayType]);
        if (rows === null) return null;
        tiers[dayType] = rows;
      }
      const divisor = requiredCount(form.divisor, 1, 400);
      if (divisor === undefined) return null;
      return {
        type: "overtime",
        parameters: {
          monthlyHoursDivisor: divisor,
          tiersByDayType: tiers,
          roundingMode: form.roundingMode,
        },
      };
    }
    case "thr": {
      const minTenure = requiredCount(form.minTenure, 0, 120);
      const fullTenure = requiredCount(form.fullTenure, 1, 120);
      if (minTenure === undefined || fullTenure === undefined) return null;
      return {
        type: "thr",
        parameters: {
          minTenureMonths: minTenure,
          fullTenureMonths: fullTenure,
          roundingMode: form.roundingMode,
        },
      };
    }
  }
}

// ---- Small editors --------------------------------------------------------

function RoundingField({
  value,
  disabled,
  onChange,
}: {
  value: RoundingMode;
  disabled: boolean;
  onChange: (value: RoundingMode) => void;
}) {
  const t = useT();
  return (
    <FormField label={t("payrollConfig.statutory.form.rounding")} required>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as RoundingMode)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ROUNDING_KEYS) as RoundingMode[]).map((mode) => (
            <SelectItem key={mode} value={mode}>
              {t(ROUNDING_KEYS[mode])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function BracketEditor({
  rows,
  disabled,
  onChange,
}: {
  rows: BracketForm[];
  disabled: boolean;
  onChange: (rows: BracketForm[]) => void;
}) {
  const t = useT();
  function update(index: number, patch: Partial<BracketForm>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function add() {
    const last = rows.at(-1) ?? { upToIdr: "", rateBp: "" };
    onChange([...rows.slice(0, -1), { upToIdr: "", rateBp: "" }, last]);
  }
  function remove(index: number) {
    if (rows.length <= 1) return;
    onChange(rows.filter((_, i) => i !== index));
  }
  return (
    <div className="grid gap-2">
      <div className="hidden gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <span className="type-eyebrow text-muted-foreground">
          {t("payrollConfig.statutory.form.bracketUpTo")}
        </span>
        <span className="type-eyebrow text-muted-foreground">
          {t("payrollConfig.statutory.form.bracketRate")}
        </span>
        <span className="w-control-sm" aria-hidden="true" />
      </div>
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        return (
          <div
            key={index}
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Input
              aria-label={t("payrollConfig.statutory.form.bracketUpTo", {
                index: index + 1,
              })}
              inputMode="numeric"
              value={row.upToIdr}
              placeholder={
                last ? t("payrollConfig.statutory.form.bracketOpen") : undefined
              }
              onChange={(event) =>
                update(index, {
                  upToIdr: maskRupiahTyping(event.target.value),
                })
              }
              disabled={disabled || last}
              autoComplete="off"
            />
            <Input
              aria-label={t("payrollConfig.statutory.form.bracketRate", {
                index: index + 1,
              })}
              inputMode="decimal"
              value={row.rateBp}
              onChange={(event) =>
                update(index, { rateBp: event.target.value })
              }
              disabled={disabled}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("payrollConfig.statutory.form.bracketRemove", {
                index: index + 1,
              })}
              onClick={() => remove(index)}
              disabled={disabled || rows.length <= 1}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={disabled}
        >
          <Plus aria-hidden="true" />
          {t("payrollConfig.statutory.form.bracketAdd")}
        </Button>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payrollConfig.statutory.form.bracketLastHint")}
        </p>
      </div>
    </div>
  );
}

function TierEditor({
  rows,
  disabled,
  onChange,
}: {
  rows: TierForm[];
  disabled: boolean;
  onChange: (rows: TierForm[]) => void;
}) {
  const t = useT();
  function update(index: number, patch: Partial<TierForm>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function add() {
    const last = rows.at(-1) ?? { toHour: "", multiplier: "1" };
    onChange([...rows.slice(0, -1), { toHour: "", multiplier: "1" }, last]);
  }
  function remove(index: number) {
    if (rows.length <= 1) return;
    onChange(rows.filter((_, i) => i !== index));
  }
  return (
    <div className="grid gap-2">
      <div className="hidden gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <span className="type-eyebrow text-muted-foreground">
          {t("payrollConfig.statutory.form.tierTo")}
        </span>
        <span className="type-eyebrow text-muted-foreground">
          {t("payrollConfig.statutory.form.multiplier")}
        </span>
        <span className="w-control-sm" aria-hidden="true" />
      </div>
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        return (
          <div
            key={index}
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Input
              aria-label={`${t("payrollConfig.statutory.form.tierTo")} ${
                index + 1
              }`}
              inputMode="numeric"
              value={row.toHour}
              placeholder={
                last ? t("payrollConfig.statutory.form.tierOpen") : undefined
              }
              onChange={(event) =>
                update(index, { toHour: event.target.value })
              }
              disabled={disabled || last}
              autoComplete="off"
            />
            <Input
              aria-label={`${t("payrollConfig.statutory.form.multiplier")} ${
                index + 1
              }`}
              inputMode="decimal"
              value={row.multiplier}
              onChange={(event) =>
                update(index, { multiplier: event.target.value })
              }
              disabled={disabled}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("payrollConfig.statutory.form.tierRemove", {
                index: index + 1,
              })}
              onClick={() => remove(index)}
              disabled={disabled || rows.length <= 1}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={disabled}
        className="w-fit"
      >
        <Plus aria-hidden="true" />
        {t("payrollConfig.statutory.form.bracketAdd")}
      </Button>
    </div>
  );
}

// ---- Dialog ---------------------------------------------------------------

export function StatutoryFormDialog({
  version,
  versions,
  today,
  onClose,
}: {
  /** Present when editing a draft; absent when creating. */
  version?: StatutoryTableVersion;
  versions: readonly StatutoryTableVersion[];
  today: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createDraft = useCreateStatutoryDraft();
  const updateDraft = useUpdateStatutoryDraft();
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const editing = version !== undefined;
  const availableTypes = React.useMemo(
    () =>
      OVERTIME_TYPES.filter(
        (type) => versionsOfType(versions, type).length > 0,
      ),
    [versions],
  );
  const [type, setType] = React.useState<StatutoryTableType>(
    version?.type ?? availableTypes[0] ?? "bpjs_kes",
  );
  const template = React.useMemo(() => {
    if (version) return version;
    return versionsOfType(versions, type)[0];
  }, [type, version, versions]);

  const [form, setForm] = React.useState<FormState>(() =>
    template
      ? formFromDraft(draftOfVersion(template))
      : formFromDraft(draftOfVersion(fallbackVersion(versions, type))),
  );
  const [effectiveFrom, setEffectiveFrom] = React.useState(
    version?.effectiveFrom ??
      suggestStatutoryEffectiveFrom(versions, type, today),
  );
  const [legalBasis, setLegalBasis] = React.useState(
    version?.legalBasis ?? template?.legalBasis ?? "",
  );
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>(
    {},
  );

  const pending = createDraft.isPending || updateDraft.isPending;
  const disabled = pending;

  function patchForm(patch: Record<string, unknown>) {
    setForm((current) => ({ ...current, ...patch }) as FormState);
  }

  function changeType(next: StatutoryTableType) {
    setType(next);
    const nextTemplate = versionsOfType(versions, next)[0];
    if (nextTemplate) {
      setForm(formFromDraft(draftOfVersion(nextTemplate)));
      setLegalBasis(nextTemplate.legalBasis);
    }
    setEffectiveFrom(suggestStatutoryEffectiveFrom(versions, next, today));
    setErrors({});
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Record<string, string | undefined> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      found.effectiveFrom = t("payrollConfig.form.date");
    if (legalBasis.trim() === "")
      found.legalBasis = t("payrollConfig.form.required");
    const draft = buildDraft(form);
    const parsed =
      draft === null ? null : statutoryTableDraftInputSchema.safeParse(draft);
    if (parsed === null || !parsed.success)
      found.parameters = t("payrollConfig.statutory.form.invalid");
    setErrors(found);
    if (
      Object.keys(found).length > 0 ||
      parsed === null ||
      !parsed.success ||
      !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
    )
      return;

    const body = {
      draft: parsed.data,
      effectiveFrom: businessDateSchema.parse(effectiveFrom),
      legalBasis: legalBasis.trim(),
      idempotencyKey,
    };
    const onSuccess = () => {
      toast({
        title: t(
          editing
            ? "payrollConfig.statutory.updatedToast"
            : "payrollConfig.statutory.createdToast",
        ),
        tone: "success",
      });
      onClose();
    };
    const onError = (error: unknown) =>
      setErrors({ form: payrollMutationError(error, t) });

    if (editing && version) {
      updateDraft.mutate(
        { params: { versionId: version.id }, body },
        { onSuccess, onError },
      );
      return;
    }
    createDraft.mutate(body, { onSuccess, onError });
  }

  const title = editing
    ? t("payrollConfig.statutory.form.titleEdit", {
        type: t(STATUTORY_TYPE_KEYS[type]),
        version: version?.version ?? "",
      })
    : t("payrollConfig.statutory.form.titleCreate", {
        type: t(STATUTORY_TYPE_KEYS[type]),
      });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("payrollConfig.statutory.form.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-3">
            {!editing && (
              <FormField
                label={t("payrollConfig.statutory.columns.table")}
                required
              >
                <Select
                  value={type}
                  onValueChange={(value) =>
                    changeType(value as StatutoryTableType)
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTypes.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(STATUTORY_TYPE_KEYS[value])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            <FormField
              label={t("payrollConfig.statutory.form.effectiveFrom")}
              required
              error={errors.effectiveFrom}
              hint={t("payrollConfig.statutory.form.effectiveFromHint")}
            >
              <Input
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                disabled={disabled}
              />
            </FormField>
            <FormField
              label={t("payrollConfig.statutory.form.legalBasis")}
              required
              error={errors.legalBasis}
              hint={t("payrollConfig.statutory.form.legalBasisHint")}
            >
              <Input
                value={legalBasis}
                onChange={(event) => setLegalBasis(event.target.value)}
                disabled={disabled}
                maxLength={200}
              />
            </FormField>
          </div>

          <fieldset className="grid gap-3 rounded-container bg-surface-2 p-4">
            <legend className="px-1 text-sm font-semibold">
              {t("payrollConfig.statutory.form.parameters")}
            </legend>
            {form.type === "bpjs_kes" ||
            form.type === "jht" ||
            form.type === "jkm" ||
            form.type === "jp" ||
            form.type === "jkk" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {form.type === "jkk"
                  ? JKK_RISK_CLASSES.map((riskClass) => (
                      <FormField
                        key={riskClass}
                        label={t(
                          "payrollConfig.statutory.parameterLabels.jkkRate",
                          { riskClass: t(JKK_RISK_KEYS[riskClass]) },
                        )}
                        required
                      >
                        <Input
                          inputMode="decimal"
                          value={form.riskRates[riskClass]}
                          onChange={(event) =>
                            patchForm({
                              riskRates: {
                                ...form.riskRates,
                                [riskClass]: event.target.value,
                              },
                            })
                          }
                          disabled={disabled}
                          autoComplete="off"
                        />
                      </FormField>
                    ))
                  : null}
                {form.type !== "jkk" && (
                  <FormField
                    label={t("payrollConfig.statutory.form.employerRate")}
                    required
                  >
                    <Input
                      inputMode="decimal"
                      value={form.employerRate}
                      onChange={(event) =>
                        patchForm({ employerRate: event.target.value })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                )}
                <FormField
                  label={t("payrollConfig.statutory.form.employeeRate")}
                  required
                >
                  <Input
                    inputMode="decimal"
                    value={form.employeeRate}
                    onChange={(event) =>
                      patchForm({ employeeRate: event.target.value })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                <FormField label={t("payrollConfig.statutory.form.wageCap")}>
                  <Input
                    inputMode="numeric"
                    value={form.wageCap}
                    placeholder={t("payrollConfig.statutory.form.noCap")}
                    onChange={(event) =>
                      patchForm({
                        wageCap: maskRupiahTyping(event.target.value),
                      })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                <FormField label={t("payrollConfig.statutory.form.wageFloor")}>
                  <Input
                    inputMode="numeric"
                    value={form.wageFloor}
                    placeholder={t("payrollConfig.statutory.form.noCap")}
                    onChange={(event) =>
                      patchForm({
                        wageFloor: maskRupiahTyping(event.target.value),
                      })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                <RoundingField
                  value={form.roundingMode}
                  disabled={disabled}
                  onChange={(roundingMode) => patchForm({ roundingMode })}
                />
              </div>
            ) : null}

            {form.type === "ptkp" ? (
              <div className="grid gap-4 sm:grid-cols-3">
                {PTKP_STATUS_LIST.map((status) => (
                  <FormField
                    key={status}
                    label={t("payrollConfig.statutory.parameterLabels.ptkp", {
                      status,
                    })}
                    required
                  >
                    <Input
                      inputMode="numeric"
                      value={form.amounts[status]}
                      onChange={(event) =>
                        patchForm({
                          amounts: {
                            ...form.amounts,
                            [status]: maskRupiahTyping(event.target.value),
                          },
                        })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                ))}
              </div>
            ) : null}

            {form.type === "pph21_ter" ? (
              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  {PTKP_STATUS_LIST.map((status) => (
                    <FormField
                      key={status}
                      label={t(
                        "payrollConfig.statutory.form.terCategory",
                        { status },
                      )}
                      required
                    >
                      <Select
                        value={form.categories[status]}
                        onValueChange={(value) =>
                          patchForm({
                            categories: {
                              ...form.categories,
                              [status]: value as TerCategory,
                            },
                          })
                        }
                        disabled={disabled}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TER_CATEGORIES.map((category) => (
                            <SelectItem key={category} value={category}>
                              {category}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  ))}
                </div>
                {TER_CATEGORIES.map((category) => (
                  <section key={category} className="grid gap-2">
                    <h3 className="text-sm font-semibold">
                      {t("payrollConfig.statutory.form.bracketsFor", {
                        category,
                      })}
                    </h3>
                    <BracketEditor
                      rows={form.brackets[category]}
                      disabled={disabled}
                      onChange={(rows) =>
                        patchForm({
                          brackets: { ...form.brackets, [category]: rows },
                        })
                      }
                    />
                  </section>
                ))}
                <RoundingField
                  value={form.roundingMode}
                  disabled={disabled}
                  onChange={(roundingMode) => patchForm({ roundingMode })}
                />
              </div>
            ) : null}

            {form.type === "pph21_annual" ? (
              <div className="grid gap-4">
                <BracketEditor
                  rows={form.brackets}
                  disabled={disabled}
                  onChange={(brackets) => patchForm({ brackets })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t(
                      "payrollConfig.statutory.form.occupationalRate",
                    )}
                    required
                  >
                    <Input
                      inputMode="decimal"
                      value={form.occupationalRate}
                      onChange={(event) =>
                        patchForm({ occupationalRate: event.target.value })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("payrollConfig.statutory.form.occupationalCap")}
                    required
                  >
                    <Input
                      inputMode="numeric"
                      value={form.occupationalCap}
                      onChange={(event) =>
                        patchForm({
                          occupationalCap: maskRupiahTyping(
                            event.target.value,
                          ),
                        })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("payrollConfig.statutory.form.roundDownTo")}
                    required
                  >
                    <Input
                      inputMode="numeric"
                      value={form.roundDownTo}
                      onChange={(event) =>
                        patchForm({
                          roundDownTo: maskRupiahTyping(event.target.value),
                        })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("payrollConfig.statutory.form.noTaxIdSurcharge")}
                  >
                    <Input
                      inputMode="decimal"
                      value={form.noTaxIdSurcharge}
                      placeholder={t(
                        "payrollConfig.statutory.form.noSurcharge",
                      )}
                      onChange={(event) =>
                        patchForm({ noTaxIdSurcharge: event.target.value })
                      }
                      disabled={disabled}
                      autoComplete="off"
                    />
                  </FormField>
                  <RoundingField
                    value={form.roundingMode}
                    disabled={disabled}
                    onChange={(roundingMode) => patchForm({ roundingMode })}
                  />
                </div>
              </div>
            ) : null}

            {form.type === "overtime" ? (
              <div className="grid gap-4">
                <FormField
                  label={t("payrollConfig.statutory.form.divisor")}
                  required
                >
                  <Input
                    inputMode="numeric"
                    value={form.divisor}
                    onChange={(event) =>
                      patchForm({ divisor: event.target.value })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                {OVERTIME_DAY_TYPES.map((dayType) => (
                  <section key={dayType} className="grid gap-2">
                    <h3 className="text-sm font-semibold">
                      {t(
                        `payrollConfig.statutory.form.dayType.${dayType}` as Parameters<
                          typeof t
                        >[0],
                      )}
                    </h3>
                    <TierEditor
                      rows={form.tiers[dayType]}
                      disabled={disabled}
                      onChange={(rows) =>
                        patchForm({
                          tiers: { ...form.tiers, [dayType]: rows },
                        })
                      }
                    />
                  </section>
                ))}
                <RoundingField
                  value={form.roundingMode}
                  disabled={disabled}
                  onChange={(roundingMode) => patchForm({ roundingMode })}
                />
              </div>
            ) : null}

            {form.type === "thr" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label={t("payrollConfig.statutory.form.minTenure")}
                  required
                >
                  <Input
                    inputMode="numeric"
                    value={form.minTenure}
                    onChange={(event) =>
                      patchForm({ minTenure: event.target.value })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  label={t("payrollConfig.statutory.form.fullTenure")}
                  required
                >
                  <Input
                    inputMode="numeric"
                    value={form.fullTenure}
                    onChange={(event) =>
                      patchForm({ fullTenure: event.target.value })
                    }
                    disabled={disabled}
                    autoComplete="off"
                  />
                </FormField>
                <RoundingField
                  value={form.roundingMode}
                  disabled={disabled}
                  onChange={(roundingMode) => patchForm({ roundingMode })}
                />
              </div>
            ) : null}

            {errors.parameters && (
              <p className="text-sm leading-5 font-medium text-danger" role="alert">
                {errors.parameters}
              </p>
            )}
          </fieldset>

          {errors.form && (
            <p className="text-sm leading-5 font-medium text-danger" role="alert">
              {errors.form}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {t("payrollConfig.statutory.form.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The create dialog needs a version to copy into the draft; the tab only offers
 * types that have one, so the fallback is unreachable in practice and throws
 * instead of inventing zero rates (PAYR-02 fails closed).
 */
function fallbackVersion(
  versions: readonly StatutoryTableVersion[],
  type: StatutoryTableType,
): StatutoryTableVersion {
  const found = versionsOfType(versions, type)[0];
  if (!found) throw new TypeError(`No statutory version of type ${type}`);
  return found;
}
