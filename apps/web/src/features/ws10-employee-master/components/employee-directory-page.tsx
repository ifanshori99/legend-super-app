// /kelola/karyawan — the employee directory (PRD v1.7 §3 F24 "Data Karyawan &
// Organisasi"): one row per employee (NIP, name, position, unit, outlet,
// status), the four kepegawaian metrics, and the way into a profile.
//
// The contract lists employees per status/outlet, but this screen filters the
// whole catalog in memory: an HR lead searches by name or NIP across pages, so
// every page is fetched (`allPagesQuery`) and the filters run locally.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import type { Employee, EmployeeStatus } from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { NumberDisplay } from "@/components/ui/money";
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
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  useContracts,
  useEmployees,
  useOrgUnits,
  useOutlets,
  usePositions,
} from "../hooks";
import {
  ALL_FILTER,
  CONTRACT_ALERT_DAYS,
  businessDateToday,
  directoryMetrics,
  employeeTimeZone,
  filterEmployees,
  listPage,
  outletName,
} from "../lib";
import { EmployeeStatusPill } from "./employee-status";

const PAGE_SIZE = 25;

const STATUS_OPTIONS: readonly EmployeeStatus[] = [
  "active",
  "onboarding",
  "suspended",
  "resigned",
  "terminated",
] as const;

const STATUS_LABEL: Record<EmployeeStatus, MessageKey> = {
  active: "employeeMaster.status.active",
  onboarding: "employeeMaster.status.onboarding",
  suspended: "employeeMaster.status.suspended",
  resigned: "employeeMaster.status.resigned",
  terminated: "employeeMaster.status.terminated",
};

export function EmployeeDirectoryPage({
  status,
  outletId,
  onFilterChange,
}: {
  status?: EmployeeStatus;
  outletId?: string;
  /** Filters live in the URL so a metric tile can link to its own rows. */
  onFilterChange: (next: {
    status?: EmployeeStatus;
    outletId?: string;
  }) => void;
}) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);

  const employeesQuery = useEmployees();
  const positionsQuery = usePositions();
  const unitsQuery = useOrgUnits();
  const contractsQuery = useContracts();
  const outletsQuery = useOutlets();

  const employees = React.useMemo(
    () => employeesQuery.data?.data ?? [],
    [employeesQuery.data],
  );
  const contracts = React.useMemo(
    () => contractsQuery.data?.data ?? [],
    [contractsQuery.data],
  );
  const positions = React.useMemo(
    () => positionsQuery.data?.data ?? [],
    [positionsQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const outlets = React.useMemo(
    () => outletsQuery.data?.data ?? [],
    [outletsQuery.data],
  );

  // Each contract's "today" is its employee's home-outlet business date.
  const metrics = React.useMemo(
    () =>
      directoryMetrics(employees, contracts, (contract) =>
        businessDateToday(
          undefined,
          employeeTimeZone(employees, outlets, contract.employeeId),
        ),
      ),
    [employees, contracts, outlets],
  );

  const filtered = React.useMemo(
    () =>
      filterEmployees(employees, {
        search,
        status: status ?? ALL_FILTER,
        outletId: outletId ?? ALL_FILTER,
      }),
    [employees, search, status, outletId],
  );
  const pagination = listPage(filtered, page, PAGE_SIZE);
  // An active employee without a direct manager is invisible to supervisors
  // and outlet managers (limited to direct reports), so HR must see them.
  const lacksManager = (employee: Employee) =>
    employee.status === "active" && employee.managerId === null;
  const withoutManager = employees.filter(lacksManager).length;

  const pending =
    employeesQuery.isPending ||
    positionsQuery.isPending ||
    unitsQuery.isPending ||
    contractsQuery.isPending ||
    outletsQuery.isPending;
  const failed =
    employeesQuery.isError ||
    positionsQuery.isError ||
    unitsQuery.isError ||
    contractsQuery.isError ||
    outletsQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : employees.length === 0
        ? "empty"
        : "ready";
  const filtersActive =
    status !== undefined || outletId !== undefined || search.trim() !== "";

  // Never print a derived 0 while the data is loading or failed.
  const stat = (ready: React.ReactNode) =>
    pending ? (
      <Skeleton className="h-8 w-16" />
    ) : failed ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      ready
    );
  const statContext = (text: string) => (pending || failed ? undefined : text);

  const retry = () => {
    void employeesQuery.refetch();
    void positionsQuery.refetch();
    void unitsQuery.refetch();
    void contractsQuery.refetch();
    void outletsQuery.refetch();
  };

  const positionOf = (employee: Employee) =>
    positions.find((position) => position.id === employee.positionId)?.name ??
    "—";
  const unitOf = (employee: Employee) =>
    units.find((unit) => unit.id === employee.orgUnitId)?.name ?? "—";
  const outletOf = (employee: Employee) =>
    outletName(outlets, employee.homeOutletId) ?? "—";

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("employeeMaster.directory.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      {withoutManager > 0 && (
        <p
          role="status"
          className="inline-flex max-w-3xl items-start gap-2 rounded-container bg-warning-subtle px-3 py-2 text-sm leading-5 text-warning"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {t("employeeMaster.directory.noManagerSummary", {
            count: withoutManager,
          })}
        </p>
      )}

      {/* Owner Q30 (DESIGN.md §4): related metrics share one strip. */}
      <StatStrip label={t("employeeMaster.directory.metrics.label")}>
        <StatTile
          label={t("employeeMaster.directory.metrics.active")}
          value={stat(<NumberDisplay value={metrics.active} />)}
          context={statContext(
            t("employeeMaster.directory.metrics.activeContext"),
          )}
          source={
            <Link to="/kelola/karyawan" search={{ status: "active" }}>
              {t("employeeMaster.nav.employees")}
            </Link>
          }
        />
        <StatTile
          label={t("employeeMaster.directory.metrics.onboarding")}
          value={stat(<NumberDisplay value={metrics.onboarding} />)}
          context={statContext(
            t("employeeMaster.directory.metrics.onboardingContext"),
          )}
          source={
            <Link to="/kelola/karyawan" search={{ status: "onboarding" }}>
              {t("employeeMaster.status.onboarding")}
            </Link>
          }
        />
        <StatTile
          label={t("employeeMaster.directory.metrics.contractExpiring", {
            days: CONTRACT_ALERT_DAYS,
          })}
          value={stat(<NumberDisplay value={metrics.contractsDue} />)}
          context={statContext(
            t("employeeMaster.directory.metrics.contractExpiringContext"),
          )}
        />
        <StatTile
          label={t("employeeMaster.directory.metrics.offboarding")}
          value={stat(<NumberDisplay value={metrics.offboarding} />)}
          context={statContext(
            t("employeeMaster.directory.metrics.offboardingContext"),
          )}
        />
      </StatStrip>

      <DataTableShell
        title={t("employeeMaster.directory.sectionTitle")}
        description={t("employeeMaster.directory.sectionHint")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: (value) => {
            setSearch(value);
            setPage(1);
          },
          label: t("employeeMaster.directory.searchLabel"),
        }}
        actions={
          <>
            <Select
              value={status ?? ALL_FILTER}
              onValueChange={(value) => {
                setPage(1);
                onFilterChange({
                  status:
                    value === ALL_FILTER
                      ? undefined
                      : (value as EmployeeStatus),
                  outletId,
                });
              }}
            >
              <SelectTrigger
                className="h-control-sm w-full sm:w-44"
                aria-label={t("employeeMaster.directory.filters.status")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>
                  {t("employeeMaster.directory.filters.allStatuses")}
                </SelectItem>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(STATUS_LABEL[option])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={outletId ?? ALL_FILTER}
              onValueChange={(value) => {
                setPage(1);
                onFilterChange({
                  status,
                  outletId: value === ALL_FILTER ? undefined : value,
                });
              }}
            >
              <SelectTrigger
                className="h-control-sm w-full sm:w-48"
                aria-label={t("employeeMaster.directory.filters.outlet")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>
                  {t("employeeMaster.directory.filters.allOutlets")}
                </SelectItem>
                {outlets.map((outlet) => (
                  <SelectItem key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        noResults={state === "ready" && pagination.rows.length === 0}
        rowCount={filtered.length}
        empty={{
          title: filtersActive
            ? t("employeeMaster.directory.emptyFilterTitle")
            : t("employeeMaster.directory.emptyTitle"),
          description: filtersActive
            ? t("employeeMaster.directory.emptyFilterHint")
            : t("employeeMaster.directory.emptyHint"),
        }}
        page={{
          page: pagination.page,
          total: pagination.totalPages,
          onChange: setPage,
        }}
        loadingRows={8}
      >
        {/* Phones: one stacked row per employee (DESIGN.md §5 responsive). */}
        <ul className="divide-y px-4 md:hidden">
          {pagination.rows.map((employee) => (
            <li key={employee.id} className="grid gap-1.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <Link
                  to="/kelola/karyawan/$employeeId"
                  params={{ employeeId: employee.id }}
                  aria-label={t("employeeMaster.directory.openProfile", {
                    name: employee.fullName,
                  })}
                  className="min-w-0 font-medium underline-offset-4 hover:underline"
                >
                  {employee.fullName}
                </Link>
                <EmployeeStatusPill status={employee.status} />
              </div>
              {lacksManager(employee) && (
                <Badge tone="warning" className="w-fit">
                  <TriangleAlert aria-hidden="true" />
                  {t("employeeMaster.directory.noManager")}
                </Badge>
              )}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-muted-foreground">
                  {t("employeeMaster.directory.columns.employeeNo")}
                </dt>
                <dd className="tabular">{employee.employeeNo}</dd>
                <dt className="text-muted-foreground">
                  {t("employeeMaster.directory.columns.position")}
                </dt>
                <dd className="truncate">{positionOf(employee)}</dd>
                <dt className="text-muted-foreground">
                  {t("employeeMaster.directory.columns.unit")}
                </dt>
                <dd className="truncate">{unitOf(employee)}</dd>
                <dt className="text-muted-foreground">
                  {t("employeeMaster.directory.columns.outlet")}
                </dt>
                <dd className="truncate">{outletOf(employee)}</dd>
              </dl>
            </li>
          ))}
        </ul>

        {/* Tablet and desktop: the dense table. */}
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("employeeMaster.directory.columns.employeeNo")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.directory.columns.name")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.directory.columns.position")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.directory.columns.unit")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.directory.columns.outlet")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.directory.columns.status")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.rows.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell className="whitespace-nowrap tabular">
                    {employee.employeeNo}
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/kelola/karyawan/$employeeId"
                      params={{ employeeId: employee.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {employee.fullName}
                    </Link>
                    {lacksManager(employee) && (
                      <Badge tone="warning" className="ml-2">
                        <TriangleAlert aria-hidden="true" />
                        {t("employeeMaster.directory.noManager")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {positionOf(employee)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {unitOf(employee)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {outletOf(employee)}
                  </TableCell>
                  <TableCell>
                    <EmployeeStatusPill status={employee.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
    </div>
  );
}
