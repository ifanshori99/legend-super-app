// Employee pay components (PRD §3 F30 "Komponen Gaji" per employee; HR-03).
// The stored amount is salary data, so the panel reads it through
// `payroll.view`; setting an amount needs `payroll.run`. The input is a
// write-only masked salary field: it never prefills the stored amount and
// clears after a successful save.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { Employee } from "@starter/shared/hris";
import type { PayComponent } from "@starter/shared/hris/payroll";
import { setEmployeePayComponentInputSchema } from "@starter/shared/hris/payroll";
import { newIdempotencyKey } from "@/lib/idempotency";
import { isOffline, payrollMutationError } from "../errors";
import {
  useActiveEmployees,
  useEmployeePayComponents,
  usePayComponents,
  useSetEmployeePayComponent,
} from "../hooks";
import { PAY_COMPONENT_CATEGORY_KEYS } from "../labels";
import {
  businessDateToday,
  formatBusinessDate,
  maskRupiahTyping,
  parseRupiahInput,
} from "../lib";
import { PayrollOfflineState } from "./payroll-offline-state";

function employeeLabel(employee: Employee): string {
  return `${employee.fullName} · ${employee.employeeNo}`;
}

function componentLabel(component: PayComponent): string {
  return `${component.name} (${component.code})`;
}

export function EmployeeComponentsPanel({ canRun }: { canRun: boolean }) {
  const t = useT();
  const toast = useToast();
  const employeesQuery = useActiveEmployees();
  const componentsQuery = usePayComponents();
  const setAmount = useSetEmployeePayComponent();

  const [search, setSearch] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);
  // null = follow the default component; a click pins one explicitly.
  const [pickedComponentId, setPickedComponentId] = React.useState<
    string | null
  >(null);
  const [amountText, setAmountText] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(businessDateToday());
  const [formError, setFormError] = React.useState<string>();

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
  const employee = employees.find((row) => row.id === employeeId) ?? null;

  const components = React.useMemo(
    () => componentsQuery.data?.data ?? [],
    [componentsQuery.data],
  );
  const componentsById = React.useMemo(
    () =>
      new Map(components.map((component) => [String(component.id), component])),
    [components],
  );
  /** Fixed earnings are the ones an employee amount can be set for. */
  const amountComponents = React.useMemo(
    () =>
      components.filter(
        (component) =>
          component.isActive &&
          component.kind === "earning" &&
          component.recurrence === "fixed",
      ),
    [components],
  );
  const baseSalary = amountComponents.find(
    (component) => component.category === "base_salary",
  );
  // Base salary is the usual target; the picker opens on it without an effect
  // (cascading setState in an effect is a lint error in this repo).
  const defaultComponent = baseSalary ?? amountComponents[0];
  // A pinned id wins only while it is still one of the selectable components;
  // Radix may clear an unmatched value to "", which must fall back to the
  // default instead of disabling the submit button.
  const componentId =
    pickedComponentId !== null &&
    amountComponents.some(
      (component) => String(component.id) === pickedComponentId,
    )
      ? pickedComponentId
      : (defaultComponent?.id ?? "");

  const rowsQuery = useEmployeePayComponents(employeeId);
  const rows = rowsQuery.data?.data ?? [];

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee || componentId === "") return;
    const amount = parseRupiahInput(amountText);
    if (amount === null) {
      setFormError(t("payrollConfig.form.amount"));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setFormError(t("payrollConfig.form.date"));
      return;
    }
    setFormError(undefined);
    setAmount.mutate(
      {
        params: { employeeId: employee.id },
        body: setEmployeePayComponentInputSchema.parse({
          componentId,
          amountIdr: amount,
          effectiveFrom,
          idempotencyKey: newIdempotencyKey(),
        }),
      },
      {
        onSuccess: () => {
          toast({
            title: t("payrollConfig.employees.setToast"),
            tone: "success",
          });
          // Write-only: the saved amount is never echoed back into the field.
          setAmountText("");
        },
        onError: (error) => setFormError(payrollMutationError(error, t)),
      },
    );
  }

  const selectedComponent = componentsById.get(componentId);

  return (
    <CardShell>
      <Card>
        <CardHeader>
          <CardTitle>{t("payrollConfig.employees.title")}</CardTitle>
          <CardDescription>
            {t("payrollConfig.employees.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t("payrollConfig.employees.searchLabel")}>
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("payrollConfig.employees.searchPlaceholder")}
                  className="h-control-sm"
                />
              </FormField>
              <FormField label={t("payrollConfig.employees.selectLabel")}>
                <Select
                  value={employeeId ?? ""}
                  onValueChange={(value) => setEmployeeId(value)}
                  disabled={employees.length === 0}
                >
                  <SelectTrigger className="h-control-sm">
                    <SelectValue
                      placeholder={t(
                        "payrollConfig.employees.selectPlaceholder",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredEmployees.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {employeeLabel(row)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            {employeesQuery.isError ? (
              isOffline(employeesQuery.error) ? (
                <PayrollOfflineState
                  onRetry={() => void employeesQuery.refetch()}
                />
              ) : (
                <ErrorState onRetry={() => void employeesQuery.refetch()} />
              )
            ) : (
              <>
                {employees.length === 0 && !employeesQuery.isPending && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("payrollConfig.employees.noEmployees")}
                  </p>
                )}

                {!employee && (
                  <EmptyState
                    title={t("payrollConfig.employees.emptyTitle")}
                    description={t("payrollConfig.employees.emptyHint")}
                  />
                )}
              </>
            )}

            {employee && (
              <section className="grid gap-2" aria-live="polite">
                <h3 className="type-heading">
                  {t("payrollConfig.employees.listTitle", {
                    name: employee.fullName,
                  })}
                </h3>
                {rowsQuery.isPending ? (
                  <p className="text-sm text-muted-foreground">
                    {t("common.loading")}
                  </p>
                ) : rowsQuery.isError ? (
                  <ErrorState onRetry={() => void rowsQuery.refetch()} />
                ) : rows.length === 0 ? (
                  <EmptyState
                    title={t("payrollConfig.employees.noComponents")}
                    description={t("payrollConfig.employees.noComponentsHint")}
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("payrollConfig.employees.columns.component")}
                        </TableHead>
                        <TableHead numeric>
                          {t("payrollConfig.employees.columns.amount")}
                        </TableHead>
                        <TableHead>
                          {t("payrollConfig.employees.columns.effective")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const component = componentsById.get(row.componentId);
                        return (
                          <TableRow key={row.id}>
                            <TableCell>
                              <div className="grid gap-0.5">
                                <span className="font-semibold">
                                  {component?.code ?? row.componentId}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                  {component
                                    ? t(
                                        PAY_COMPONENT_CATEGORY_KEYS[
                                          component.category
                                        ],
                                      )
                                    : ""}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell numeric>
                              <Money amount={row.amountIdr} />
                            </TableCell>
                            <TableCell>
                              {row.effectiveTo === null
                                ? t("payrollConfig.employees.openEnded", {
                                    from: formatBusinessDate(row.effectiveFrom),
                                  })
                                : t("payrollConfig.employees.effectiveRange", {
                                    from: formatBusinessDate(row.effectiveFrom),
                                    to: formatBusinessDate(row.effectiveTo),
                                  })}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </section>
            )}
          </div>

          <form
            className="grid content-start gap-3 rounded-container bg-surface-2 p-4"
            onSubmit={submit}
            noValidate
          >
            <div className="grid gap-0.5">
              <h3 className="type-heading">
                {t("payrollConfig.employees.setTitle")}
              </h3>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("payrollConfig.employees.setDescription")}
              </p>
            </div>
            <FormField
              label={t("payrollConfig.employees.component")}
              required
              hint={
                amountComponents.length === 0
                  ? t("payrollConfig.employees.noBaseSalary")
                  : undefined
              }
            >
              <Select
                value={componentId}
                onValueChange={(value) =>
                  setPickedComponentId(value === "" ? null : value)
                }
                disabled={!canRun || amountComponents.length === 0}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {amountComponents.map((component) => (
                    <SelectItem key={component.id} value={component.id}>
                      {componentLabel(component)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("payrollConfig.employees.amount")}
              required
              error={
                formError === t("payrollConfig.form.amount")
                  ? formError
                  : undefined
              }
              hint={t("payrollConfig.employees.maskedHint")}
            >
              <Input
                inputMode="numeric"
                value={amountText}
                onChange={(event) =>
                  setAmountText(maskRupiahTyping(event.target.value))
                }
                placeholder={t("payrollConfig.employees.amountPlaceholder")}
                disabled={!canRun || !employee}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("payrollConfig.employees.effectiveFrom")}
              required
              error={
                formError === t("payrollConfig.form.date")
                  ? formError
                  : undefined
              }
            >
              <Input
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                disabled={!canRun || !employee}
              />
            </FormField>
            {amountText !== "" && parseRupiahInput(amountText) !== null && (
              <p className="text-sm text-muted-foreground">
                <Money amount={parseRupiahInput(amountText) ?? 0} size="sm" />
              </p>
            )}
            {selectedComponent && (
              <p className="text-sm text-muted-foreground">
                {componentLabel(selectedComponent)} ·{" "}
                {t(PAY_COMPONENT_CATEGORY_KEYS[selectedComponent.category])}
              </p>
            )}
            {formError &&
              formError !== t("payrollConfig.form.amount") &&
              formError !== t("payrollConfig.form.date") && (
                <p className="text-sm font-medium text-danger" role="alert">
                  {formError}
                </p>
              )}
            <Button
              type="submit"
              disabled={!canRun || !employee || componentId === ""}
              loading={setAmount.isPending}
              title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
            >
              {t("payrollConfig.employees.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </CardShell>
  );
}
