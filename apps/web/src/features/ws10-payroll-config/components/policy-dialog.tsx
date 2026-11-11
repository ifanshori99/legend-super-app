// Create a payroll policy or edit the editable half of one (PRD v1.7 §3 F30
// "Kebijakan Payroll"; contract `createPayrollPolicyInputSchema` /
// `updatePayrollPolicyInputSchema`). The employee group is fixed once the
// policy exists, so an edit only touches cycle, pay-date rule, JKK class and
// enrolled BPJS programmes.
import * as React from "react";
import { businessDateSchema } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type {
  BpjsTableType,
  JkkRiskClass,
  PayDateAdjustment,
  PayrollCycle,
  PayrollPolicy,
} from "@starter/shared/hris/payroll";
import {
  BPJS_TABLE_TYPES,
  JKK_RISK_CLASSES,
} from "@starter/shared/hris/payroll";
import type { EmploymentType } from "@starter/shared/hris";
import { newIdempotencyKey } from "@/lib/idempotency";
import { payrollMutationError } from "../errors";
import { useCreatePayrollPolicy, useUpdatePayrollPolicy } from "../hooks";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_KEYS } from "../labels";
import {
  JKK_RISK_KEYS,
  PAY_DATE_ADJUSTMENT_KEYS,
  STATUTORY_TYPE_KEYS,
} from "../lib";
import { useLegalEntityChoice } from "./legal-entity-field";
import { SaveErrorBanner } from "./save-error-banner";

const GROUP_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;

type Frequency = PayrollCycle["frequency"];
type Errors = Record<string, string | undefined>;

function toggle<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((item) => item !== value);
}

function dayOfMonth(value: string): number | null | "invalid" {
  if (value.trim() === "") return null;
  if (!/^\d{1,2}$/.test(value.trim())) return "invalid";
  const day = Number(value);
  return day >= 1 && day <= 28 ? day : "invalid";
}

function daysAfter(value: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(value.trim())) return null;
  const days = Number(value);
  return days >= 0 && days <= max ? days : null;
}

export function PolicyDialog({
  policy,
  defaultLegalEntityId,
  onClose,
}: {
  /** Absent when creating a policy. */
  policy?: PayrollPolicy;
  /** Entity of an existing policy, preselected when creating another one. */
  defaultLegalEntityId?: PayrollPolicy["legalEntityId"] | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createPolicy = useCreatePayrollPolicy();
  const updatePolicy = useUpdatePayrollPolicy();
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const [name, setName] = React.useState(policy?.name ?? "");
  const [groupCode, setGroupCode] = React.useState(
    policy?.employeeGroup.code ?? "",
  );
  const [groupName, setGroupName] = React.useState(
    policy?.employeeGroup.name ?? "",
  );
  const [employmentTypes, setEmploymentTypes] = React.useState<
    EmploymentType[]
  >(policy ? [...policy.employeeGroup.employmentTypes] : ["pkwtt", "pkwt"]);
  const [frequency, setFrequency] = React.useState<Frequency>(
    policy?.cycle.frequency ?? "monthly",
  );
  const [cutoffDay, setCutoffDay] = React.useState(
    policy?.cycle.frequency === "monthly" && policy.cycle.cutoffDay !== null
      ? String(policy.cycle.cutoffDay)
      : "",
  );
  const [payDay, setPayDay] = React.useState(
    policy?.cycle.frequency === "monthly" && policy.cycle.payDay !== null
      ? String(policy.cycle.payDay)
      : "",
  );
  const [payMonthOffset, setPayMonthOffset] = React.useState<0 | 1>(
    policy?.cycle.frequency === "monthly" ? policy.cycle.payMonthOffset : 0,
  );
  const [anchorDate, setAnchorDate] = React.useState(
    policy?.cycle.frequency === "biweekly" ? policy.cycle.anchorDate : "",
  );
  const [payDaysAfterPeriodEnd, setPayDaysAfterPeriodEnd] = React.useState(
    policy &&
      (policy.cycle.frequency === "biweekly" ||
        policy.cycle.frequency === "daily")
      ? String(policy.cycle.payDaysAfterPeriodEnd)
      : "1",
  );
  const [payDateAdjustment, setPayDateAdjustment] =
    React.useState<PayDateAdjustment>(
      policy?.payDateAdjustment ?? "previous_working_day",
    );
  const [jkkRiskClass, setJkkRiskClass] = React.useState<JkkRiskClass>(
    policy?.jkkRiskClass ?? "low",
  );
  const [bpjsProgrammes, setBpjsProgrammes] = React.useState<BpjsTableType[]>(
    policy ? [...policy.bpjsProgrammes] : [...BPJS_TABLE_TYPES],
  );
  const [isActive, setIsActive] = React.useState(policy?.isActive ?? true);
  const [errors, setErrors] = React.useState<Errors>({});

  const pending = createPolicy.isPending || updatePolicy.isPending;
  const editing = policy !== undefined;
  const entityChoice = useLegalEntityChoice({
    preferredId: defaultLegalEntityId ?? null,
    emptyKey: "legalEntity.emptyPolicy",
    error: errors.legalEntityId,
    disabled: pending,
  });
  const legalEntityId = entityChoice.legalEntityId;

  function buildCycle(): PayrollCycle | null {
    if (frequency === "monthly") {
      const cutoff = dayOfMonth(cutoffDay);
      const pay = dayOfMonth(payDay);
      if (cutoff === "invalid" || pay === "invalid") return null;
      return {
        frequency: "monthly",
        cutoffDay: cutoff,
        payDay: pay,
        payMonthOffset,
      };
    }
    const days = daysAfter(
      payDaysAfterPeriodEnd,
      frequency === "biweekly" ? 14 : 7,
    );
    if (days === null) return null;
    if (frequency === "biweekly") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return null;
      return {
        frequency: "biweekly",
        anchorDate: businessDateSchema.parse(anchorDate),
        payDaysAfterPeriodEnd: days,
      };
    }
    return { frequency: "daily", payDaysAfterPeriodEnd: days };
  }

  function validate(): Errors {
    const next: Errors = {};
    if (name.trim() === "") next.name = t("payrollConfig.form.required");
    if (!editing) {
      if (legalEntityId === "")
        next.legalEntityId = t("payrollConfig.legalEntity.required");
      if (!GROUP_CODE_PATTERN.test(groupCode.trim()))
        next.groupCode = t("payrollConfig.policies.form.groupCodeHint");
      if (groupName.trim() === "")
        next.groupName = t("payrollConfig.form.required");
      if (employmentTypes.length === 0)
        next.employmentTypes = t("payrollConfig.form.employmentTypes");
    }
    if (frequency === "monthly") {
      if (dayOfMonth(cutoffDay) === "invalid")
        next.cutoffDay = t("payrollConfig.form.dayOfMonth");
      if (dayOfMonth(payDay) === "invalid")
        next.payDay = t("payrollConfig.form.dayOfMonth");
      const cutoff = dayOfMonth(cutoffDay);
      const pay = dayOfMonth(payDay);
      if (
        payMonthOffset === 0 &&
        typeof cutoff === "number" &&
        typeof pay === "number" &&
        pay <= cutoff
      )
        next.payDay = t("payrollConfig.policies.form.payDayAfterCutoff");
    } else if (
      daysAfter(payDaysAfterPeriodEnd, frequency === "biweekly" ? 14 : 7) ===
      null
    ) {
      next.payDaysAfterPeriodEnd = t("payrollConfig.form.number");
    } else if (
      frequency === "biweekly" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
    ) {
      next.anchorDate = t("payrollConfig.form.date");
    }
    if (bpjsProgrammes.length === 0)
      next.bpjsProgrammes = t("payrollConfig.form.bpjsProgrammes");
    return next;
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validate();
    const cycle = buildCycle();
    if (cycle === null && found.payDay === undefined)
      found.payDay = t("payrollConfig.form.dayOfMonth");
    setErrors(found);
    if (found.legalEntityId !== undefined) entityChoice.focus();
    if (Object.keys(found).length > 0 || cycle === null) return;

    const onSuccess = () => {
      toast({
        title: t(
          editing
            ? "payrollConfig.policies.updatedToast"
            : "payrollConfig.policies.createdToast",
        ),
        tone: "success",
      });
      onClose();
    };
    const onError = (error: unknown) =>
      setErrors({ form: payrollMutationError(error, t) });

    if (editing && policy) {
      updatePolicy.mutate(
        {
          params: { payrollPolicyId: policy.id },
          body: {
            name: name.trim(),
            cycle,
            payDateAdjustment,
            jkkRiskClass,
            bpjsProgrammes,
            isActive,
            idempotencyKey,
          },
        },
        { onSuccess, onError },
      );
      return;
    }
    if (legalEntityId === "") return;
    createPolicy.mutate(
      {
        legalEntityId,
        name: name.trim(),
        employeeGroup: {
          code: groupCode.trim(),
          name: groupName.trim(),
          employmentTypes,
        },
        cycle,
        payDateAdjustment,
        jkkRiskClass,
        bpjsProgrammes,
        idempotencyKey,
      },
      { onSuccess, onError },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              editing
                ? "payrollConfig.policies.form.titleEdit"
                : "payrollConfig.policies.form.titleCreate",
            )}
          </DialogTitle>
          <DialogDescription>
            {t("payrollConfig.policies.form.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          {errors.form && <SaveErrorBanner message={errors.form} />}

          {!editing && entityChoice.field}

          <FormField
            label={t("payrollConfig.policies.form.name")}
            required
            error={errors.name}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              maxLength={100}
              autoComplete="off"
            />
          </FormField>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-semibold">
              {t("payrollConfig.policies.form.groupTitle")}
            </legend>
            {editing && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("payrollConfig.policies.form.groupFixed")}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("payrollConfig.policies.form.groupCode")}
                required={!editing}
                error={errors.groupCode}
                hint={
                  editing
                    ? undefined
                    : t("payrollConfig.policies.form.groupCodeHint")
                }
              >
                <Input
                  value={groupCode}
                  onChange={(event) =>
                    setGroupCode(event.target.value.toUpperCase())
                  }
                  disabled={pending || editing}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField
                label={t("payrollConfig.policies.form.groupName")}
                required={!editing}
                error={errors.groupName}
              >
                <Input
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  disabled={pending || editing}
                  maxLength={100}
                />
              </FormField>
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              {EMPLOYMENT_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex min-h-control-sm items-center gap-2"
                >
                  <Checkbox
                    checked={employmentTypes.includes(type)}
                    onCheckedChange={(checked) =>
                      setEmploymentTypes((current) =>
                        toggle(current, type, checked === true),
                      )
                    }
                    disabled={pending || editing}
                  />
                  <span>{t(EMPLOYMENT_TYPE_KEYS[type])}</span>
                </label>
              ))}
            </div>
            {errors.employmentTypes && (
              <p className="text-sm font-medium text-danger" role="alert">
                {errors.employmentTypes}
              </p>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("payrollConfig.policies.form.cycle")} required>
              <Select
                value={frequency}
                onValueChange={(value) => setFrequency(value as Frequency)}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">
                    {t("payrollConfig.policies.cycle.monthly")}
                  </SelectItem>
                  <SelectItem value="biweekly">
                    {t("payrollConfig.policies.cycle.biweekly")}
                  </SelectItem>
                  <SelectItem value="daily">
                    {t("payrollConfig.policies.cycle.daily")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("payrollConfig.policies.form.payDateAdjustment")}
              required
            >
              <Select
                value={payDateAdjustment}
                onValueChange={(value) =>
                  setPayDateAdjustment(value as PayDateAdjustment)
                }
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(PAY_DATE_ADJUSTMENT_KEYS) as PayDateAdjustment[]
                  ).map((rule) => (
                    <SelectItem key={rule} value={rule}>
                      {t(PAY_DATE_ADJUSTMENT_KEYS[rule])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {frequency === "monthly" && (
              <>
                <FormField
                  label={t("payrollConfig.policies.form.cutoffDay")}
                  error={errors.cutoffDay}
                  hint={t("payrollConfig.policies.form.cutoffDayHint")}
                >
                  <Input
                    inputMode="numeric"
                    value={cutoffDay}
                    onChange={(event) => setCutoffDay(event.target.value)}
                    disabled={pending}
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  label={t("payrollConfig.policies.form.payDay")}
                  error={errors.payDay}
                  hint={t("payrollConfig.policies.form.payDayHint")}
                >
                  <Input
                    inputMode="numeric"
                    value={payDay}
                    onChange={(event) => setPayDay(event.target.value)}
                    disabled={pending}
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  label={t("payrollConfig.policies.form.payMonthOffset")}
                  required
                >
                  <Select
                    value={String(payMonthOffset)}
                    onValueChange={(value) =>
                      setPayMonthOffset(value === "1" ? 1 : 0)
                    }
                    disabled={pending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">
                        {t("payrollConfig.policies.form.payMonthOffsetSame")}
                      </SelectItem>
                      <SelectItem value="1">
                        {t("payrollConfig.policies.form.payMonthOffsetNext")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </>
            )}

            {frequency === "biweekly" && (
              <>
                <FormField
                  label={t("payrollConfig.policies.form.anchorDate")}
                  required
                  error={errors.anchorDate}
                  hint={t("payrollConfig.policies.form.anchorDateHint")}
                >
                  <Input
                    type="date"
                    value={anchorDate}
                    onChange={(event) => setAnchorDate(event.target.value)}
                    disabled={pending}
                  />
                </FormField>
                <FormField
                  label={t("payrollConfig.policies.form.payDaysAfterPeriodEnd")}
                  required
                  error={errors.payDaysAfterPeriodEnd}
                >
                  <Input
                    inputMode="numeric"
                    value={payDaysAfterPeriodEnd}
                    onChange={(event) =>
                      setPayDaysAfterPeriodEnd(event.target.value)
                    }
                    disabled={pending}
                    autoComplete="off"
                  />
                </FormField>
              </>
            )}

            {frequency === "daily" && (
              <FormField
                label={t("payrollConfig.policies.form.payDaysAfterPeriodEnd")}
                required
                error={errors.payDaysAfterPeriodEnd}
              >
                <Input
                  inputMode="numeric"
                  value={payDaysAfterPeriodEnd}
                  onChange={(event) =>
                    setPayDaysAfterPeriodEnd(event.target.value)
                  }
                  disabled={pending}
                  autoComplete="off"
                />
              </FormField>
            )}

            <FormField
              label={t("payrollConfig.policies.form.jkkRiskClass")}
              required
            >
              <Select
                value={jkkRiskClass}
                onValueChange={(value) =>
                  setJkkRiskClass(value as JkkRiskClass)
                }
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JKK_RISK_CLASSES.map((riskClass) => (
                    <SelectItem key={riskClass} value={riskClass}>
                      {t(JKK_RISK_KEYS[riskClass])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              {t("payrollConfig.policies.form.bpjsProgrammes")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("payrollConfig.policies.form.bpjsProgrammesHint")}
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {BPJS_TABLE_TYPES.map((programme) => (
                <label
                  key={programme}
                  className="flex min-h-control-sm items-center gap-2"
                >
                  <Checkbox
                    checked={bpjsProgrammes.includes(programme)}
                    onCheckedChange={(checked) =>
                      setBpjsProgrammes((current) =>
                        toggle(current, programme, checked === true),
                      )
                    }
                    disabled={pending}
                  />
                  <span>{t(STATUTORY_TYPE_KEYS[programme])}</span>
                </label>
              ))}
            </div>
            {errors.bpjsProgrammes && (
              <p className="text-sm font-medium text-danger" role="alert">
                {errors.bpjsProgrammes}
              </p>
            )}
          </fieldset>

          <div className="flex items-start justify-between gap-4 border-t pt-3">
            <div className="grid gap-0.5">
              <Label htmlFor="payroll-policy-active">
                {t("payrollConfig.policies.form.active")}
              </Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("payrollConfig.policies.form.activeHint")}
              </p>
            </div>
            <Switch
              id="payroll-policy-active"
              checked={isActive}
              onCheckedChange={setIsActive}
              disabled={pending}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={pending}
              disabled={!editing && entityChoice.blocked}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
