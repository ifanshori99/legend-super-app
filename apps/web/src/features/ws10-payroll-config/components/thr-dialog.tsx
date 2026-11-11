// Create a THR schedule (contract `createThrScheduleInputSchema`, PRD §3 F30
// "THR"). The dialog explains the exact-date tenure rule before the user picks
// dates: masa kerja counts whole months up to `tenureAsOfDate`, so 31 Januari
// – 28 Februari is zero months, not one.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { Employee } from "@starter/shared/hris";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { ThrCreateInput } from "../api";
import { payrollMutationError } from "../errors";
import { useActiveEmployees, useCreateThrSchedule } from "../hooks";
import { useLegalEntityChoice } from "./legal-entity-field";
import { SaveErrorBanner } from "./save-error-banner";

type Scope = "all" | "selected";
type Errors = Record<string, string | undefined>;

function toggle<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((item) => item !== value);
}

export function ThrDialog({
  defaultLegalEntityId,
  onClose,
}: {
  /** Entity of an existing schedule, preselected when creating another one. */
  defaultLegalEntityId?: ThrCreateInput["legalEntityId"] | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createSchedule = useCreateThrSchedule();
  const employeesQuery = useActiveEmployees();
  const [idempotencyKey] = React.useState(() => newIdempotencyKey());

  const [name, setName] = React.useState("");
  const [holidayName, setHolidayName] = React.useState("");
  const [holidayDate, setHolidayDate] = React.useState("");
  const [tenureAsOfDate, setTenureAsOfDate] = React.useState("");
  const [payDate, setPayDate] = React.useState("");
  const [scope, setScope] = React.useState<Scope>("all");
  const [employeeIds, setEmployeeIds] = React.useState<Employee["id"][]>([]);
  const [search, setSearch] = React.useState("");
  const [errors, setErrors] = React.useState<Errors>({});

  const employees = employeesQuery.data?.data ?? [];
  const needle = search.trim().toLocaleLowerCase("id-ID");
  const filteredEmployees =
    needle === ""
      ? employees
      : employees.filter((employee) =>
          `${employee.fullName} ${employee.employeeNo}`
            .toLocaleLowerCase("id-ID")
            .includes(needle),
        );

  const pending = createSchedule.isPending;
  const entityChoice = useLegalEntityChoice({
    preferredId: defaultLegalEntityId ?? null,
    emptyKey: "legalEntity.emptyThr",
    error: errors.legalEntityId,
    disabled: pending,
  });
  const legalEntityId = entityChoice.legalEntityId;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Errors = {};
    if (name.trim() === "") found.name = t("payrollConfig.form.required");
    if (holidayName.trim() === "")
      found.holidayName = t("payrollConfig.form.required");
    for (const [field, value] of [
      ["holidayDate", holidayDate],
      ["tenureAsOfDate", tenureAsOfDate],
      ["payDate", payDate],
    ] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        found[field] = t("payrollConfig.form.date");
    }
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(holidayDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(payDate) &&
      payDate > holidayDate
    )
      found.payDate = t("payrollConfig.thr.form.payAfterHoliday");
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(holidayDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(tenureAsOfDate) &&
      tenureAsOfDate > holidayDate
    )
      found.tenureAsOfDate = t("payrollConfig.thr.form.tenureAfterHoliday");
    if (scope === "selected" && employeeIds.length === 0)
      found.employeeIds = t("payrollConfig.thr.form.employeeRequired");
    if (legalEntityId === "")
      found.legalEntityId = t("payrollConfig.legalEntity.required");
    setErrors(found);
    if (found.legalEntityId !== undefined) entityChoice.focus();
    if (Object.keys(found).length > 0 || legalEntityId === "") return;

    createSchedule.mutate(
      {
        legalEntityId,
        name: name.trim(),
        holidayName: holidayName.trim(),
        holidayDate: businessDateSchema.parse(holidayDate),
        tenureAsOfDate: businessDateSchema.parse(tenureAsOfDate),
        payDate: businessDateSchema.parse(payDate),
        employeeIds: scope === "selected" ? [...employeeIds] : null,
        idempotencyKey,
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollConfig.thr.createdToast"),
            tone: "success",
          });
          onClose();
        },
        onError: (error) => setErrors({ form: payrollMutationError(error, t) }),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("payrollConfig.thr.form.title")}</DialogTitle>
          <DialogDescription>
            {t("payrollConfig.thr.form.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          {errors.form && <SaveErrorBanner message={errors.form} />}

          {entityChoice.field}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("payrollConfig.thr.form.name")}
              required
              error={errors.name}
              hint={t("payrollConfig.thr.form.nameHint")}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
                maxLength={100}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("payrollConfig.thr.form.holidayName")}
              required
              error={errors.holidayName}
            >
              <Input
                value={holidayName}
                onChange={(event) => setHolidayName(event.target.value)}
                disabled={pending}
                maxLength={100}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("payrollConfig.thr.form.holidayDate")}
              required
              error={errors.holidayDate}
            >
              <Input
                type="date"
                value={holidayDate}
                onChange={(event) => {
                  setHolidayDate(event.target.value);
                  if (tenureAsOfDate === "")
                    setTenureAsOfDate(event.target.value);
                  if (payDate === "") setPayDate(event.target.value);
                }}
                disabled={pending}
              />
            </FormField>
            <FormField
              label={t("payrollConfig.thr.form.payDate")}
              required
              error={errors.payDate}
              hint={t("payrollConfig.thr.form.payDateHint")}
            >
              <Input
                type="date"
                value={payDate}
                onChange={(event) => setPayDate(event.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField
              label={t("payrollConfig.thr.form.tenureAsOf")}
              required
              error={errors.tenureAsOfDate}
              hint={t("payrollConfig.thr.form.tenureHint")}
            >
              <Input
                type="date"
                value={tenureAsOfDate}
                onChange={(event) => setTenureAsOfDate(event.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField label={t("payrollConfig.thr.form.scope")} required>
              <Select
                value={scope}
                onValueChange={(value) => setScope(value as Scope)}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("payrollConfig.thr.form.scopeAll")}
                  </SelectItem>
                  <SelectItem value="selected">
                    {t("payrollConfig.thr.form.scopeSelected")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {scope === "selected" && (
            <fieldset className="grid gap-2 rounded-container bg-surface-2 p-3">
              <legend className="px-1 text-sm font-semibold">
                {t("payrollConfig.thr.form.scopeSelected")}
              </legend>
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("payrollConfig.thr.form.employeeSearch")}
                aria-label={t("payrollConfig.thr.form.employeeSearch")}
                className="h-control-sm"
              />
              <div className="grid max-h-56 gap-1 overflow-y-auto">
                {filteredEmployees.map((employee) => (
                  <label
                    key={employee.id}
                    className="flex min-h-control-sm items-center gap-2"
                  >
                    <Checkbox
                      checked={employeeIds.includes(employee.id)}
                      onCheckedChange={(checked) =>
                        setEmployeeIds((current) =>
                          toggle(current, employee.id, checked === true),
                        )
                      }
                      disabled={pending}
                    />
                    <span className="text-sm">
                      {employee.fullName} · {employee.employeeNo}
                    </span>
                  </label>
                ))}
                {filteredEmployees.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("payrollConfig.thr.form.employeeEmpty")}
                  </p>
                )}
              </div>
              {errors.employeeIds && (
                <p className="text-sm font-medium text-danger" role="alert">
                  {errors.employeeIds}
                </p>
              )}
            </fieldset>
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
            <Button
              type="submit"
              loading={pending}
              disabled={entityChoice.blocked}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
