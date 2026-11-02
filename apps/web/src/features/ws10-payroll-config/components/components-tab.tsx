// Pay components (PRD v1.7 §3 F30 "Komponen Gaji"): the earning/deduction
// catalog with tax and wage-base flags. System components come with the
// tenant; admin-made ones are created here and can be deactivated, never
// deleted (a payslip line references the component).
import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PayComponent } from "@starter/shared/hris/payroll";
import { usePayComponents } from "../hooks";
import {
  PAY_COMPONENT_CATEGORY_KEYS,
  PAY_COMPONENT_KIND_KEYS,
  PAY_COMPONENT_RECURRENCE_KEYS,
} from "../labels";
import { EmployeeComponentsPanel } from "./employee-components-panel";
import { PayComponentDialog } from "./pay-component-dialog";

function ComponentBasis({ component }: { component: PayComponent }) {
  const t = useT();
  const flags = [
    component.taxable && t("payrollConfig.components.basis.taxable"),
    component.bpjsBase && t("payrollConfig.components.basis.bpjs"),
    component.overtimeBase && t("payrollConfig.components.basis.overtime"),
    component.thrBase && t("payrollConfig.components.basis.thr"),
  ].filter((label): label is string => typeof label === "string");
  if (flags.length === 0)
    return (
      <span className="text-sm text-muted-foreground">
        {t("payrollConfig.components.basis.none")}
      </span>
    );
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((label) => (
        <Badge key={label} tone="neutral">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function ComponentIdentity({ component }: { component: PayComponent }) {
  const t = useT();
  return (
    <div className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-1 font-semibold">
        {component.code}
        {component.isSystem && (
          <Badge tone="brand">{t("payrollConfig.components.systemBadge")}</Badge>
        )}
      </span>
      <span className="text-sm text-muted-foreground">{component.name}</span>
    </div>
  );
}

export function ComponentsTab({ canRun }: { canRun: boolean }) {
  const t = useT();
  const componentsQuery = usePayComponents();

  const [search, setSearch] = React.useState("");
  const [editing, setEditing] = React.useState<PayComponent | "create" | null>(
    null,
  );

  const components = componentsQuery.data?.data ?? [];
  const needle = search.trim().toLocaleLowerCase("id-ID");
  const rows = components.filter((component) => {
    if (needle === "") return true;
    return `${component.code} ${component.name}`
      .toLocaleLowerCase("id-ID")
      .includes(needle);
  });

  const systemCount = components.filter((component) => component.isSystem).length;
  const customCount = components.length - systemCount;
  const deductionCount = components.filter(
    (component) => component.kind === "deduction",
  ).length;
  const nextDisplayOrder =
    components.reduce((max, component) => Math.max(max, component.displayOrder), 0) +
    10;

  const editLabel = t("payrollConfig.components.edit");

  return (
    <>
      <StatStrip label={t("payrollConfig.components.metrics.label")}>
        <StatTile
          label={t("payrollConfig.components.metrics.total")}
          value={components.length}
        />
        <StatTile
          label={t("payrollConfig.components.metrics.system")}
          value={systemCount}
        />
        <StatTile
          label={t("payrollConfig.components.metrics.custom")}
          value={customCount}
        />
        <StatTile
          label={t("payrollConfig.components.metrics.deductions")}
          value={deductionCount}
        />
      </StatStrip>

      <DataTableShell
        title={t("payrollConfig.components.title")}
        description={t("payrollConfig.components.description")}
        state={
          componentsQuery.isPending
            ? "loading"
            : componentsQuery.isError
              ? "error"
              : components.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("payrollConfig.components.searchLabel"),
        }}
        actions={
          <Button
            type="button"
            onClick={() => setEditing("create")}
            disabled={!canRun}
            title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
          >
            <Plus aria-hidden="true" />
            {t("payrollConfig.components.add")}
          </Button>
        }
        onRetry={() => void componentsQuery.refetch()}
        empty={{
          title: t("payrollConfig.components.emptyTitle"),
          description: t("payrollConfig.components.emptyHint"),
        }}
        noResults={components.length > 0 && rows.length === 0}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("payrollConfig.components.columns.component")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.components.columns.category")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.components.columns.kind")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.components.columns.flags")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.components.columns.recurrence")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.components.columns.active")}
                </TableHead>
                <TableHead numeric>
                  {t("payrollConfig.components.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((component) => (
                <TableRow key={component.id}>
                  <TableCell>
                    <ComponentIdentity component={component} />
                  </TableCell>
                  <TableCell>
                    {t(PAY_COMPONENT_CATEGORY_KEYS[component.category])}
                  </TableCell>
                  <TableCell>
                    {t(PAY_COMPONENT_KIND_KEYS[component.kind])}
                  </TableCell>
                  <TableCell>
                    <ComponentBasis component={component} />
                  </TableCell>
                  <TableCell>
                    {t(PAY_COMPONENT_RECURRENCE_KEYS[component.recurrence])}
                  </TableCell>
                  <TableCell>
                    <Badge tone={component.isActive ? "success" : "neutral"}>
                      {t(
                        component.isActive
                          ? "payrollConfig.policies.active"
                          : "payrollConfig.components.inactiveBadge",
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell numeric>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${editLabel} ${component.code}`}
                      onClick={() => setEditing(component)}
                      disabled={!canRun}
                      title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((component) => (
            <li
              key={component.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <ComponentIdentity component={component} />
                <Badge tone={component.isActive ? "success" : "neutral"}>
                  {t(
                    component.isActive
                      ? "payrollConfig.policies.active"
                      : "payrollConfig.components.inactiveBadge",
                  )}
                </Badge>
              </div>
              <p className="text-sm">
                {t(PAY_COMPONENT_CATEGORY_KEYS[component.category])}
                {" · "}
                {t(PAY_COMPONENT_KIND_KEYS[component.kind])}
                {" · "}
                {t(PAY_COMPONENT_RECURRENCE_KEYS[component.recurrence])}
              </p>
              <ComponentBasis component={component} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(component)}
                disabled={!canRun}
                title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
              >
                <Pencil aria-hidden="true" />
                {editLabel}
              </Button>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <EmployeeComponentsPanel canRun={canRun} />

      {editing && (
        <PayComponentDialog
          component={editing === "create" ? undefined : editing}
          nextDisplayOrder={nextDisplayOrder}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
