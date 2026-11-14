// Payroll policies (PRD v1.7 §3 F30 "Kebijakan Payroll"): one row per employee
// group with its cycle, cut-off/pay day, pay-date rule and enrolled BPJS
// programmes. The overtime formula and THR proration are not policy fields in
// the contract — they live in versioned statutory tables, so this tab reads the
// published versions and links to the statutory tab instead of copying them.
import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PayrollCycle, PayrollPolicy } from "@starter/shared/hris/payroll";
import { isOffline } from "../errors";
import { usePayrollPolicies, useStatutoryTables } from "../hooks";
import {
  CYCLE_LABEL_KEYS,
  JKK_RISK_KEYS,
  PAY_DATE_ADJUSTMENT_KEYS,
  STATUTORY_TYPE_KEYS,
  businessDateToday,
  cycleSummary,
  employeeGroupSummary,
  filterPolicies,
  formatMultiplierInput,
  publishedVersionOf,
} from "../lib";
import { PolicyDialog } from "./policy-dialog";
import { PayrollOfflineState } from "./payroll-offline-state";

type CycleFilter = PayrollCycle["frequency"] | "all";

function PolicyStatusPill({ active }: { active: boolean }) {
  const t = useT();
  return (
    <Badge tone={active ? "success" : "neutral"}>
      {t(
        active
          ? "payrollConfig.policies.active"
          : "payrollConfig.policies.inactive",
      )}
    </Badge>
  );
}

export function PoliciesTab({ canRun }: { canRun: boolean }) {
  const t = useT();
  const policiesQuery = usePayrollPolicies();
  const statutoryQuery = useStatutoryTables();

  const [search, setSearch] = React.useState("");
  const [cycle, setCycle] = React.useState<CycleFilter>("all");
  const [editing, setEditing] = React.useState<PayrollPolicy | "create" | null>(
    null,
  );

  const policies = policiesQuery.data?.data ?? [];
  const rows = filterPolicies(policies, search, cycle);
  const versions = statutoryQuery.data?.data ?? [];
  const today = businessDateToday();
  const overtime = publishedVersionOf(versions, "overtime", today);
  const thr = publishedVersionOf(versions, "thr", today);
  const defaultLegalEntityId = policies[0]?.legalEntityId ?? null;

  const activeCount = policies.filter((policy) => policy.isActive).length;
  const groups = new Set(policies.map((policy) => policy.employeeGroup.code));
  const monthly = policies.filter(
    (policy) => policy.cycle.frequency === "monthly",
  ).length;
  const programmes = new Set(
    policies.flatMap((policy) => [...policy.bpjsProgrammes]),
  );

  const editLabel = t("payrollConfig.policies.edit");
  // Counts and rules are only real once their query succeeded: while loading
  // or failed they read as a dash / skeleton, never as an invented 0 or as
  // "rule not published".
  const metric = (value: number) => (policiesQuery.isSuccess ? value : "—");
  const rule = (text: string) =>
    statutoryQuery.isPending ? (
      <Skeleton className="h-5 w-3/4" />
    ) : statutoryQuery.isSuccess ? (
      text
    ) : (
      "—"
    );

  if (policiesQuery.isError && isOffline(policiesQuery.error))
    return <PayrollOfflineState onRetry={() => void policiesQuery.refetch()} />;

  return (
    <>
      <StatStrip label={t("payrollConfig.policies.metrics.label")}>
        <StatTile
          label={t("payrollConfig.policies.metrics.active")}
          value={metric(activeCount)}
        />
        <StatTile
          label={t("payrollConfig.policies.metrics.groups")}
          value={metric(groups.size)}
        />
        <StatTile
          label={t("payrollConfig.policies.metrics.monthly")}
          value={metric(monthly)}
        />
        <StatTile
          label={t("payrollConfig.policies.metrics.bpjs")}
          value={metric(programmes.size)}
        />
      </StatStrip>

      <CardShell>
        <Card>
          <CardHeader>
            <CardTitle>{t("payrollConfig.policies.rulesTitle")}</CardTitle>
            <CardDescription>
              {t("payrollConfig.policies.rulesDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="text-sm leading-5">
              {rule(
                overtime
                  ? t("payrollConfig.policies.overtimeRule", {
                      divisor: overtime.parameters.monthlyHoursDivisor,
                      multipliers: overtime.parameters.tiersByDayType.workday
                        .map((tier) => formatMultiplierInput(tier.multiplier))
                        .join(" · "),
                    })
                  : t("payrollConfig.policies.overtimeRuleNone"),
              )}
            </div>
            <div className="text-sm leading-5">
              {rule(
                thr
                  ? t("payrollConfig.policies.thrRule", {
                      min: thr.parameters.minTenureMonths,
                      full: thr.parameters.fullTenureMonths,
                    })
                  : t("payrollConfig.policies.thrRuleNone"),
              )}
            </div>
          </CardContent>
        </Card>
      </CardShell>

      <DataTableShell
        title={t("payrollConfig.policies.title")}
        description={t("payrollConfig.policies.description")}
        state={
          policiesQuery.isPending
            ? "loading"
            : policiesQuery.isError
              ? "error"
              : policies.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("payrollConfig.policies.searchLabel"),
        }}
        actions={
          <>
            <Select
              value={cycle}
              onValueChange={(value) => setCycle(value as CycleFilter)}
            >
              <SelectTrigger
                aria-label={t("payrollConfig.policies.columns.cycle")}
                className="h-control-sm sm:w-40"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("payrollConfig.policies.columns.cycle")}
                </SelectItem>
                {(
                  Object.keys(CYCLE_LABEL_KEYS) as PayrollCycle["frequency"][]
                ).map((frequency) => (
                  <SelectItem key={frequency} value={frequency}>
                    {t(CYCLE_LABEL_KEYS[frequency])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={() => setEditing("create")}
              disabled={!canRun}
              title={!canRun ? t("payrollConfig.readOnlyHint") : undefined}
            >
              <Plus aria-hidden="true" />
              {t("payrollConfig.policies.add")}
            </Button>
          </>
        }
        error={policiesQuery.error}
        onRetry={() => void policiesQuery.refetch()}
        empty={{
          title: t("payrollConfig.policies.emptyTitle"),
          description: t("payrollConfig.policies.emptyHint"),
        }}
        noResults={policies.length > 0 && rows.length === 0}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("payrollConfig.policies.columns.policy")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.policies.columns.cycle")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.policies.columns.schedule")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.policies.columns.payDate")}
                </TableHead>
                <TableHead>{t("payrollConfig.policies.columns.jkk")}</TableHead>
                <TableHead>
                  {t("payrollConfig.policies.columns.bpjs")}
                </TableHead>
                <TableHead>
                  {t("payrollConfig.policies.columns.status")}
                </TableHead>
                <TableHead numeric>
                  {t("payrollConfig.policies.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((policy) => (
                <TableRow key={policy.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-semibold">{policy.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {employeeGroupSummary(policy.employeeGroup)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {t(CYCLE_LABEL_KEYS[policy.cycle.frequency])}
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    {cycleSummary(policy.cycle, t)}
                  </TableCell>
                  <TableCell>
                    {t(PAY_DATE_ADJUSTMENT_KEYS[policy.payDateAdjustment])}
                  </TableCell>
                  <TableCell>{t(JKK_RISK_KEYS[policy.jkkRiskClass])}</TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    {policy.bpjsProgrammes
                      .map((programme) => t(STATUTORY_TYPE_KEYS[programme]))
                      .join(" · ")}
                  </TableCell>
                  <TableCell>
                    <PolicyStatusPill active={policy.isActive} />
                  </TableCell>
                  <TableCell numeric>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${editLabel} ${policy.name}`}
                      onClick={() => setEditing(policy)}
                      disabled={!canRun}
                      title={
                        !canRun ? t("payrollConfig.readOnlyHint") : undefined
                      }
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
          {rows.map((policy) => (
            <li
              key={policy.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-semibold">{policy.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {employeeGroupSummary(policy.employeeGroup)}
                  </span>
                </div>
                <PolicyStatusPill active={policy.isActive} />
              </div>
              <p className="text-sm">
                {t(CYCLE_LABEL_KEYS[policy.cycle.frequency])}
                {" · "}
                {cycleSummary(policy.cycle, t)}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(PAY_DATE_ADJUSTMENT_KEYS[policy.payDateAdjustment])}
                {" · "}
                {t(JKK_RISK_KEYS[policy.jkkRiskClass])}
              </p>
              <p className="text-sm text-muted-foreground">
                {policy.bpjsProgrammes
                  .map((programme) => t(STATUTORY_TYPE_KEYS[programme]))
                  .join(" · ")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(policy)}
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

      {editing && (
        <PolicyDialog
          policy={editing === "create" ? undefined : editing}
          defaultLegalEntityId={defaultLegalEntityId}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
