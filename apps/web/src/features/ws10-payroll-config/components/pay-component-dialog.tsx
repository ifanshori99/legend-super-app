// Create a pay component or edit its flags (contract `pay_components`, PRD
// §3 F30 "Komponen Gaji"). The code and category are fixed once a component
// exists; a deduction cannot become taxable or part of a wage base (the
// contract's `checkComponentFlags`), so those switches are disabled for it.
import * as React from "react";
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
  PayComponent,
  PayComponentCategory,
  PayComponentRecurrence,
  TaxScheme,
} from "@starter/shared/hris/payroll";
import { payComponentKindOf } from "@starter/shared/hris/payroll";
import { newIdempotencyKey } from "@/lib/idempotency";
import { payrollMutationError } from "../errors";
import { useCreatePayComponent, useUpdatePayComponent } from "../hooks";
import {
  PAY_COMPONENT_CATEGORIES,
  PAY_COMPONENT_CATEGORY_KEYS,
  PAY_COMPONENT_RECURRENCE_KEYS,
  TAX_SCHEME_KEYS,
} from "../labels";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;

type Errors = Record<string, string | undefined>;

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && (
          <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

export function PayComponentDialog({
  component,
  nextDisplayOrder,
  onClose,
}: {
  component?: PayComponent;
  nextDisplayOrder: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createComponent = useCreatePayComponent();
  const updateComponent = useUpdatePayComponent();
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const editing = component !== undefined;
  const [code, setCode] = React.useState(component?.code ?? "");
  const [name, setName] = React.useState(component?.name ?? "");
  const [category, setCategory] = React.useState<PayComponentCategory>(
    component?.category ?? "custom_earning",
  );
  const [recurrence, setRecurrence] = React.useState<PayComponentRecurrence>(
    component?.recurrence ?? "fixed",
  );
  const [displayOrder, setDisplayOrder] = React.useState(
    String(component?.displayOrder ?? nextDisplayOrder),
  );
  const [taxScheme, setTaxScheme] = React.useState<TaxScheme>(
    component?.taxScheme ?? "gross",
  );
  const [taxable, setTaxable] = React.useState(component?.taxable ?? true);
  const [bpjsBase, setBpjsBase] = React.useState(component?.bpjsBase ?? false);
  const [overtimeBase, setOvertimeBase] = React.useState(
    component?.overtimeBase ?? false,
  );
  const [thrBase, setThrBase] = React.useState(component?.thrBase ?? false);
  const [isActive, setIsActive] = React.useState(component?.isActive ?? true);
  const [errors, setErrors] = React.useState<Errors>({});

  const pending = createComponent.isPending || updateComponent.isPending;
  const kind = payComponentKindOf(category);
  const deduction = kind === "deduction";
  const reimbursement = category === "reimbursement";
  const basesDisabled = pending || deduction || reimbursement;

  function changeCategory(next: PayComponentCategory) {
    setCategory(next);
    if (payComponentKindOf(next) === "deduction") {
      setTaxable(false);
      setBpjsBase(false);
      setOvertimeBase(false);
      setThrBase(false);
      return;
    }
    if (next === "reimbursement") setTaxable(false);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Errors = {};
    if (!editing && !CODE_PATTERN.test(code.trim()))
      found.code = t("payrollConfig.form.code");
    if (name.trim() === "") found.name = t("payrollConfig.form.required");
    if (!/^\d{1,3}$/.test(displayOrder.trim()) || Number(displayOrder) > 999)
      found.displayOrder = t("payrollConfig.form.number");
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const onSuccess = () => {
      toast({
        title: t(
          editing
            ? "payrollConfig.components.updatedToast"
            : "payrollConfig.components.createdToast",
        ),
        tone: "success",
      });
      onClose();
    };
    const onError = (error: unknown) =>
      setErrors({ form: payrollMutationError(error, t) });

    // Disabled checkboxes never submit a stale "on": deductions and
    // reimbursements are neither taxable nor part of any wage base.
    const noBases = deduction || reimbursement;
    const flags = {
      name: name.trim(),
      taxable: noBases ? false : taxable,
      taxScheme,
      bpjsBase: noBases ? false : bpjsBase,
      overtimeBase: noBases ? false : overtimeBase,
      thrBase: noBases ? false : thrBase,
      displayOrder: Number(displayOrder),
    };

    if (editing && component) {
      updateComponent.mutate(
        {
          params: { componentId: component.id },
          body: { ...flags, isActive, idempotencyKey },
        },
        { onSuccess, onError },
      );
      return;
    }
    createComponent.mutate(
      {
        code: code.trim(),
        ...flags,
        category,
        recurrence,
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
                ? "payrollConfig.components.form.titleEdit"
                : "payrollConfig.components.form.titleCreate",
            )}
          </DialogTitle>
          <DialogDescription>
            {t("payrollConfig.components.form.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("payrollConfig.components.form.code")}
              required={!editing}
              error={errors.code}
              hint={
                editing
                  ? undefined
                  : t("payrollConfig.components.form.codeHint")
              }
            >
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                disabled={pending || editing}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label={t("payrollConfig.components.form.name")}
              required
              error={errors.name}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
                maxLength={100}
              />
            </FormField>
            <FormField
              label={t("payrollConfig.components.form.category")}
              required
              hint={
                editing
                  ? t("payrollConfig.components.form.description")
                  : undefined
              }
            >
              <Select
                value={category}
                onValueChange={(value) =>
                  changeCategory(value as PayComponentCategory)
                }
                disabled={pending || editing}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAY_COMPONENT_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(PAY_COMPONENT_CATEGORY_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("payrollConfig.components.form.recurrence")}
              required
              hint={
                editing
                  ? undefined
                  : t("payrollConfig.components.form.recurrenceHint")
              }
            >
              <Select
                value={recurrence}
                onValueChange={(value) =>
                  setRecurrence(value as PayComponentRecurrence)
                }
                disabled={pending || editing}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(
                      PAY_COMPONENT_RECURRENCE_KEYS,
                    ) as PayComponentRecurrence[]
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(PAY_COMPONENT_RECURRENCE_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("payrollConfig.components.form.displayOrder")}
              required
              error={errors.displayOrder}
            >
              <Input
                inputMode="numeric"
                value={displayOrder}
                onChange={(event) => setDisplayOrder(event.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("payrollConfig.components.form.taxScheme")}
              required
            >
              <Select
                value={taxScheme}
                onValueChange={(value) => setTaxScheme(value as TaxScheme)}
                disabled={pending || deduction}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TAX_SCHEME_KEYS) as TaxScheme[]).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {t(TAX_SCHEME_KEYS[value])}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <fieldset className="grid gap-1 divide-y divide-border">
            <legend className="pb-2 text-sm font-semibold">
              {t("payrollConfig.components.form.basisHint")}
            </legend>
            <SwitchRow
              id="pay-component-taxable"
              label={t("payrollConfig.components.form.taxable")}
              checked={taxable}
              disabled={basesDisabled}
              onCheckedChange={setTaxable}
            />
            <SwitchRow
              id="pay-component-bpjs"
              label={t("payrollConfig.components.form.bpjsBase")}
              checked={bpjsBase}
              disabled={basesDisabled}
              onCheckedChange={setBpjsBase}
            />
            <SwitchRow
              id="pay-component-overtime"
              label={t("payrollConfig.components.form.overtimeBase")}
              checked={overtimeBase}
              disabled={basesDisabled}
              onCheckedChange={setOvertimeBase}
            />
            <SwitchRow
              id="pay-component-thr"
              label={t("payrollConfig.components.form.thrBase")}
              checked={thrBase}
              disabled={basesDisabled}
              onCheckedChange={setThrBase}
            />
            {editing && (
              <SwitchRow
                id="pay-component-active"
                label={t("payrollConfig.components.form.active")}
                checked={isActive}
                disabled={pending}
                onCheckedChange={setIsActive}
              />
            )}
          </fieldset>

          {errors.form && (
            <p
              className="text-sm leading-5 font-medium text-danger"
              role="alert"
            >
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
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
