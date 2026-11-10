// Service-charge distribution (PRD v1.7 §3 D.30 "Distribusi Service Charge";
// PAYR-04): pools per period, the calculated split per employee, and the
// reconciliation that the shares add up to the pool exactly. Approval here is
// what lets a payroll run distribute the pool when it locks; the transfer/cash
// split of the net is on the run screen, where the contract carries it.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { HandCoins, Scale } from "lucide-react";
import type { Employee, Position } from "@starter/shared/hris";
import type { ServiceChargePool } from "@starter/shared/hris/payroll";
import type { AreaAccess } from "@/lib/areas/access";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money, NumberDisplay } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useTenantContext } from "@/lib/tenant-context";
import { isOffline, payrollErrorMessage } from "../errors";
import { payrollAccess } from "../guard";
import {
  useAllocations,
  useApprovePool,
  useCalculatePool,
  useEmployees,
  usePools,
  usePositions,
} from "../hooks";
import {
  allocatedTotal,
  allocationsReconcile,
  formatBusinessDate,
  formatSharePercent,
  POOL_METHOD_LABEL,
  POOL_STATUS_LABEL,
  POOL_STATUS_TONE,
  periodRange,
  shortId,
  sortPools,
} from "../lib";
import { CreatePoolDialog } from "./create-pool-dialog";

type PoolAction = "calculate" | "approve";

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh screen, so a
 * selected pool or open dialog of the previous outlet cannot leak into this one.
 */
export function ServiceChargePage({ access }: { access: AreaAccess }) {
  const { outlet } = useTenantContext();
  return <ServiceChargeContent key={outlet?.id ?? "none"} access={access} />;
}

function ServiceChargeContent({ access }: { access: AreaAccess }) {
  const t = useT();
  const toast = useToast();
  const { outlet } = useTenantContext();
  const permissions = payrollAccess(access);
  const pools = usePools(outlet?.id);
  const employees = useEmployees();
  const positions = usePositions();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [action, setAction] = React.useState<PoolAction | null>(null);
  const calculate = useCalculatePool();
  const approve = useApprovePool();
  const [error, setError] = React.useState<string | null>(null);

  const poolRows = React.useMemo(
    () => sortPools(pools.data?.data ?? []),
    [pools.data],
  );
  // No selection yet means the newest pool, so the table always has a subject.
  const selected: ServiceChargePool | null =
    poolRows.find((pool) => pool.id === selectedId) ?? poolRows[0] ?? null;
  // Per-employee shares are compensation (HR-03): salary readers and the pool
  // approver see them; the mock answers 403 to anyone else.
  const canSeeAllocations =
    permissions.canViewSalaries || permissions.canApprove;
  const allocations = useAllocations(selected?.id, canSeeAllocations);

  const employeeById = React.useMemo(
    () =>
      new Map<string, Employee>(
        (employees.data?.data ?? []).map((row): [string, Employee] => [
          row.id,
          row,
        ]),
      ),
    [employees.data],
  );
  const positionById = React.useMemo(
    () =>
      new Map<string, Position>(
        (positions.data?.data ?? []).map((row): [string, Position] => [
          row.id,
          row,
        ]),
      ),
    [positions.data],
  );

  const allocationsRows = allocations.data?.data ?? [];
  const allocated = allocatedTotal(allocationsRows);
  const reconciles = allocationsReconcile(selected, allocationsRows);
  const remaining = selected ? selected.amountIdr - allocated : 0;

  const poolsState: DataState = !outlet
    ? "empty"
    : pools.isPending
      ? "loading"
      : pools.isError
        ? "error"
        : poolRows.length === 0
          ? "empty"
          : "ready";
  const allocationsState: DataState = !canSeeAllocations
    ? "empty"
    : allocations.isPending || employees.isPending || positions.isPending
      ? "loading"
      : allocations.isError
        ? "error"
        : allocationsRows.length === 0
          ? "empty"
          : "ready";

  if (pools.isError && isOffline(pools.error)) {
    return (
      <div className="grid gap-4">
        <p className="text-sm leading-5 font-medium text-danger">
          {t("payrollRun.error.offlineTitle")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void pools.refetch()}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const canCalculate =
    permissions.canRun &&
    selected !== null &&
    (selected.status === "draft" || selected.status === "calculated");
  const canApprove =
    permissions.canApprove &&
    selected !== null &&
    selected.status === "calculated";

  function runAction(kind: PoolAction) {
    if (!selected) return;
    setError(null);
    const onSuccess = () => {
      toast({
        title: t(
          kind === "calculate"
            ? "payrollRun.pool.toastCalculated"
            : "payrollRun.pool.toastApproved",
        ),
        tone: "success",
      });
      setAction(null);
    };
    const onError = (cause: unknown) => setError(payrollErrorMessage(cause, t));
    if (kind === "calculate")
      calculate.mutate(selected.id, { onSuccess, onError });
    else approve.mutate(selected.id, { onSuccess, onError });
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <section
        aria-label={t("payrollRun.pool.pageLabel")}
        className="flex flex-col gap-3 rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline"
      >
        <div className="flex flex-col gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="type-title">{t("payrollRun.pool.title")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("payrollRun.pool.description")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!permissions.canRun || !outlet}
            onClick={() => setCreateOpen(true)}
          >
            <HandCoins aria-hidden="true" />
            {t("payrollRun.pool.create")}
          </Button>
        </div>
      </section>

      <DataTableShell
        title={t("payrollRun.pool.listTitle")}
        description={t("payrollRun.pool.listDescription")}
        state={poolsState}
        error={pools.error}
        onRetry={() => void pools.refetch()}
        rowCount={poolRows.length}
        empty={{
          title: t("payrollRun.pool.emptyTitle"),
          description: t("payrollRun.pool.emptyHint"),
          action:
            permissions.canRun && outlet ? (
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <HandCoins aria-hidden="true" />
                {t("payrollRun.pool.create")}
              </Button>
            ) : undefined,
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("payrollRun.pool.columnPeriod")}</TableHead>
              <TableHead>{t("payrollRun.pool.columnMethod")}</TableHead>
              <TableHead numeric>{t("payrollRun.pool.columnAmount")}</TableHead>
              <TableHead>{t("payrollRun.pool.columnStatus")}</TableHead>
              <TableHead>{t("payrollRun.pool.columnRun")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("payrollRun.pool.columnAction")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {poolRows.map((pool) => (
              <TableRow
                key={pool.id}
                data-state={pool.id === selected?.id ? "selected" : undefined}
              >
                <TableCell className="font-semibold">
                  {periodRange(pool.periodStart, pool.periodEnd)}
                </TableCell>
                <TableCell>{t(POOL_METHOD_LABEL[pool.rule.method])}</TableCell>
                <TableCell numeric>
                  <Money amount={pool.amountIdr} />
                </TableCell>
                <TableCell>
                  <StatusPill status={POOL_STATUS_TONE[pool.status]}>
                    {t(POOL_STATUS_LABEL[pool.status])}
                  </StatusPill>
                </TableCell>
                <TableCell>
                  {pool.payrollRunId === null ? (
                    <span className="text-muted-foreground">
                      {t("payrollRun.pool.notDistributed")}
                    </span>
                  ) : (
                    <Link
                      to="/kelola/payroll/run/$runId"
                      params={{ runId: pool.payrollRunId }}
                      className="font-semibold text-primary underline-offset-4 hover:underline"
                    >
                      {shortId(pool.payrollRunId)}
                    </Link>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant={pool.id === selected?.id ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setSelectedId(pool.id)}
                  >
                    {t("payrollRun.pool.viewAllocations")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      <StatStrip label={t("payrollRun.pool.stripLabel")}>
        <StatTile
          label={t("payrollRun.pool.stripPool")}
          value={
            selected ? (
              <Money amount={selected.amountIdr} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={
            selected
              ? periodRange(selected.periodStart, selected.periodEnd)
              : t("payrollRun.pool.emptyHint")
          }
        />
        <StatTile
          label={t("payrollRun.pool.stripAllocated")}
          value={
            canSeeAllocations && allocations.isSuccess ? (
              <Money amount={allocated} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.pool.stripAllocatedContext")}
        />
        <StatTile
          label={t("payrollRun.pool.stripRecipients")}
          value={
            canSeeAllocations && allocations.isSuccess ? (
              <NumberDisplay value={allocationsRows.length} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.pool.stripRecipientsContext")}
        />
        <StatTile
          label={t("payrollRun.pool.stripRemaining")}
          value={
            canSeeAllocations && allocations.isSuccess ? (
              <Money amount={remaining} size="stat" />
            ) : (
              <span className="text-muted-foreground">
                {t("payrollRun.common.none")}
              </span>
            )
          }
          context={t("payrollRun.pool.stripRemainingContext")}
        />
      </StatStrip>

      {selected && (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={POOL_STATUS_TONE[selected.status]}>
            {t(POOL_STATUS_LABEL[selected.status])}
          </StatusPill>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canCalculate}
            onClick={() => setAction("calculate")}
          >
            <Scale aria-hidden="true" />
            {t("payrollRun.pool.calculate")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canApprove}
            onClick={() => setAction("approve")}
          >
            {t("payrollRun.pool.approve")}
          </Button>
          {!canCalculate && !canApprove && (
            <p className="text-sm leading-5 text-muted-foreground">
              {selected.status === "distributed"
                ? t("payrollRun.pool.distributedHint")
                : selected.status === "approved"
                  ? t("payrollRun.pool.approvedHint")
                  : t("payrollRun.pool.actionHint")}
            </p>
          )}
        </div>
      )}

      <DataTableShell
        title={t("payrollRun.pool.allocationsTitle")}
        description={t("payrollRun.pool.allocationsDescription")}
        state={selected === null ? "empty" : allocationsState}
        error={allocations.error}
        onRetry={() => void allocations.refetch()}
        rowCount={allocationsRows.length}
        actions={
          selected !== null && allocationsRows.length > 0 ? (
            reconciles ? (
              <StatusPill status="success">
                {t("payrollRun.pool.reconciles")}
              </StatusPill>
            ) : (
              <StatusPill status="danger">
                {t("payrollRun.pool.mismatch")}
              </StatusPill>
            )
          ) : undefined
        }
        empty={{
          title: t("payrollRun.pool.allocationsEmptyTitle"),
          description: canSeeAllocations
            ? t("payrollRun.pool.allocationsEmptyHint")
            : t("payrollRun.pool.allocationsRestricted"),
          action:
            canSeeAllocations && canCalculate && selected !== null ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setAction("calculate")}
              >
                <Scale aria-hidden="true" />
                {t("payrollRun.pool.calculate")}
              </Button>
            ) : undefined,
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("payrollRun.pool.columnEmployee")}</TableHead>
              <TableHead>{t("payrollRun.pool.columnPosition")}</TableHead>
              <TableHead numeric>{t("payrollRun.pool.columnPoints")}</TableHead>
              <TableHead numeric>
                {t("payrollRun.pool.columnAttendance")}
              </TableHead>
              <TableHead numeric>{t("payrollRun.pool.columnShare")}</TableHead>
              <TableHead numeric>{t("payrollRun.pool.columnAmount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allocationsRows.map((row) => {
              const employee = employeeById.get(row.employeeId);
              const position =
                employee?.positionId === null ||
                employee?.positionId === undefined
                  ? undefined
                  : positionById.get(employee.positionId);
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-semibold">
                      {employee?.fullName ?? shortId(row.employeeId)}
                    </p>
                    <p className="text-xs leading-4 text-muted-foreground tabular">
                      {employee?.employeeNo ?? t("payrollRun.common.none")}
                    </p>
                  </TableCell>
                  <TableCell>
                    {position?.name ?? t("payrollRun.common.none")}
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {row.points}
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {row.attendanceDays}
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {selected
                      ? formatSharePercent(row.amountIdr, selected.amountIdr)
                      : t("payrollRun.common.none")}
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.amountIdr} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5}>
                <span className="flex items-center gap-2">
                  {t("payrollRun.pool.totalRow")}
                  <Badge tone="neutral">
                    <NumberDisplay value={allocationsRows.length} />
                  </Badge>
                </span>
              </TableCell>
              <TableCell numeric>
                <Money amount={allocated} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </DataTableShell>

      <p className="text-sm leading-5 text-muted-foreground">
        {t("payrollRun.pool.transferCashHint")}
      </p>

      <CreatePoolDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog
        open={action !== null}
        onOpenChange={(open) => !open && setAction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "calculate"
                ? t("payrollRun.pool.confirmCalculateTitle")
                : t("payrollRun.pool.confirmApproveTitle")}
            </DialogTitle>
            <DialogDescription>
              {action === "calculate"
                ? t("payrollRun.pool.confirmCalculateBody")
                : t("payrollRun.pool.confirmApproveBody")}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className="grid grid-cols-2 gap-3 rounded-container bg-surface-2 p-3 text-sm">
              <div className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("payrollRun.pool.columnAmount")}
                </dt>
                <dd className="font-semibold">
                  <Money amount={selected.amountIdr} />
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("payrollRun.pool.stripRecipients")}
                </dt>
                <dd className="font-semibold tabular">
                  <NumberDisplay value={allocationsRows.length} />
                </dd>
              </div>
              <div className="col-span-2 grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">
                  {t("payrollRun.pool.columnPeriod")}
                </dt>
                <dd>
                  {selected.periodStart === selected.periodEnd
                    ? formatBusinessDate(selected.periodStart)
                    : periodRange(selected.periodStart, selected.periodEnd)}
                </dd>
              </div>
            </dl>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAction(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={calculate.isPending || approve.isPending}
              onClick={() => action && runAction(action)}
            >
              {action === "calculate"
                ? t("payrollRun.pool.calculate")
                : t("payrollRun.pool.approve")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
