// /kelola/organisasi — the organisation chart and position catalogue (PRD v1.7
// §3 F24 "Struktur Organisasi": units, positions, grades, direct manager and
// outlet placement, plotted as a chart).
//
// There is no org-structure endpoint in the contract, so the chart is composed
// here from `listOrgUnits` (the self-referencing tree), `listPositions`,
// `listPositionGrades` and the employee directory (headcount). It is a nested
// list of cards with connector lines — no chart library.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
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
  useEmployees,
  useOrgUnits,
  usePositionGrades,
  usePositions,
} from "../hooks";
import {
  DASH,
  buildOrgTree,
  formatDecimalText,
  positionRows,
  type OrgNode,
} from "../lib";

export function OrganizationStructurePage() {
  const t = useT();
  const [search, setSearch] = React.useState("");

  const unitsQuery = useOrgUnits();
  const positionsQuery = usePositions();
  const gradesQuery = usePositionGrades();
  const employeesQuery = useEmployees();

  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const positions = React.useMemo(
    () => positionsQuery.data?.data ?? [],
    [positionsQuery.data],
  );
  const grades = React.useMemo(
    () => gradesQuery.data?.data ?? [],
    [gradesQuery.data],
  );
  const employees = React.useMemo(
    () => employeesQuery.data?.data ?? [],
    [employeesQuery.data],
  );

  const tree = React.useMemo(
    () => buildOrgTree(units, positions, employees),
    [units, positions, employees],
  );
  const rows = React.useMemo(
    () => positionRows(positions, units, grades, employees),
    [positions, units, grades, employees],
  );

  const pending =
    unitsQuery.isPending ||
    positionsQuery.isPending ||
    gradesQuery.isPending ||
    employeesQuery.isPending;
  const failed =
    unitsQuery.isError ||
    positionsQuery.isError ||
    gradesQuery.isError ||
    employeesQuery.isError;

  const retry = () => {
    void unitsQuery.refetch();
    void positionsQuery.refetch();
    void gradesQuery.refetch();
    void employeesQuery.refetch();
  };

  const searchText = search.trim().toLocaleLowerCase("id-ID");
  const filteredRows = rows.filter((row) => {
    if (searchText === "") return true;
    const haystack = [
      row.position.name,
      row.unit?.name ?? "",
      row.grade?.name ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase("id-ID");
    return haystack.includes(searchText);
  });

  const tableState: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  // Derived metrics, never a placeholder number while loading.
  const stat = (ready: React.ReactNode) =>
    pending ? (
      <Skeleton className="h-8 w-16" />
    ) : failed ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      ready
    );
  const statContext = (text: string) => (pending || failed ? undefined : text);

  const activeUnits = units.filter((unit) => unit.isActive).length;
  const activePositions = positions.filter(
    (position) => position.isActive,
  ).length;
  const activeEmployees = employees.filter(
    (employee) => employee.status === "active",
  ).length;

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("employeeMaster.organization.subtitle")}
        </p>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      <StatStrip label={t("employeeMaster.organization.metricsLabel")}>
        <StatTile
          label={t("employeeMaster.organization.metrics.units")}
          value={stat(<NumberDisplay value={activeUnits} />)}
          context={statContext(
            t("employeeMaster.organization.metrics.unitsContext"),
          )}
        />
        <StatTile
          label={t("employeeMaster.organization.metrics.positions")}
          value={stat(<NumberDisplay value={activePositions} />)}
          context={statContext(
            t("employeeMaster.organization.metrics.positionsContext"),
          )}
        />
        <StatTile
          label={t("employeeMaster.organization.metrics.headcount")}
          value={stat(<NumberDisplay value={activeEmployees} />)}
          context={statContext(
            t("employeeMaster.organization.metrics.headcountContext"),
          )}
        />
        <StatTile
          label={t("employeeMaster.organization.metrics.grades")}
          value={stat(<NumberDisplay value={grades.length} />)}
          context={statContext(
            t("employeeMaster.organization.metrics.gradesContext"),
          )}
        />
      </StatStrip>

      <CardShell aria-labelledby="org-chart-title">
        <CardShellBody className="gap-4 p-card">
          <div className="grid gap-1">
            <h2 id="org-chart-title" className="type-title">
              {t("employeeMaster.organization.chartTitle")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("employeeMaster.organization.chartHint")}
            </p>
          </div>

          {pending ? (
            <div className="grid gap-2">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="ml-6 h-24 w-[calc(100%-1.5rem)]" />
              <Skeleton className="ml-6 h-24 w-[calc(100%-1.5rem)]" />
            </div>
          ) : failed ? (
            <ErrorState
              title={t("employeeMaster.organization.errorTitle")}
              onRetry={retry}
            />
          ) : tree.length === 0 ? (
            <EmptyState
              title={t("employeeMaster.organization.emptyTitle")}
              description={t("employeeMaster.organization.emptyHint")}
            />
          ) : (
            <ul className="grid gap-3">
              {tree.map((node) => (
                <UnitBranch key={node.unit.id} node={node} depth={0} />
              ))}
            </ul>
          )}
        </CardShellBody>
      </CardShell>

      <DataTableShell
        title={t("employeeMaster.organization.positionsTitle")}
        description={t("employeeMaster.organization.positionsHint")}
        state={tableState}
        onRetry={retry}
        search={{
          value: search,
          onChange: setSearch,
          label: t("employeeMaster.organization.positionsLabel"),
        }}
        noResults={tableState === "ready" && filteredRows.length === 0}
        rowCount={filteredRows.length}
        empty={{
          title: t("employeeMaster.organization.noPositionsTitle"),
          description: t("employeeMaster.organization.noPositionsHint"),
        }}
        loadingRows={6}
      >
        {/* Phones: stacked position rows. */}
        <ul className="divide-y px-4 md:hidden">
          {filteredRows.map((row) => (
            <li key={row.position.id} className="grid gap-1.5 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{row.position.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {row.unit?.name ??
                      t("employeeMaster.organization.unassigned")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral">
                    {t("employeeMaster.organization.directHeadcount", {
                      count: row.headcount,
                    })}
                  </Badge>
                  {!row.position.isActive && (
                    <Badge tone="warning">
                      {t("employeeMaster.organization.inactive")}
                    </Badge>
                  )}
                </div>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-muted-foreground">
                  {t("employeeMaster.organization.columns.grade")}
                </dt>
                <dd className="truncate">
                  {row.grade?.name ?? t("employeeMaster.organization.noGrade")}
                </dd>
                <dt className="text-muted-foreground">
                  {t("employeeMaster.organization.columns.points")}
                </dt>
                <dd className="tabular">
                  {formatDecimalText(row.position.serviceChargePoints)}
                </dd>
                <dt className="text-muted-foreground">
                  {t("employeeMaster.organization.columns.headcount")}
                </dt>
                <dd className="tabular">{row.headcount}</dd>
              </dl>
            </li>
          ))}
        </ul>

        {/* Tablet and desktop. */}
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("employeeMaster.organization.columns.position")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.organization.columns.unit")}
                </TableHead>
                <TableHead>
                  {t("employeeMaster.organization.columns.grade")}
                </TableHead>
                <TableHead numeric>
                  {t("employeeMaster.organization.columns.level")}
                </TableHead>
                <TableHead numeric>
                  {t("employeeMaster.organization.columns.points")}
                </TableHead>
                <TableHead numeric>
                  {t("employeeMaster.organization.columns.headcount")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => (
                <TableRow key={row.position.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{row.position.name}</span>
                      {!row.position.isActive && (
                        <span className="text-xs leading-4 text-muted-foreground">
                          {t("employeeMaster.organization.inactive")}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.unit?.name ??
                      t("employeeMaster.organization.unassigned")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.grade?.name ??
                      t("employeeMaster.organization.noGrade")}
                  </TableCell>
                  <TableCell numeric>{row.grade?.level ?? DASH}</TableCell>
                  <TableCell numeric>
                    {formatDecimalText(row.position.serviceChargePoints)}
                  </TableCell>
                  <TableCell numeric>{row.headcount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
    </div>
  );
}

/**
 * One unit and its sub-units: a card per unit, joined by a vertical connector
 * (`border-l`) and a short tick per child, so the hierarchy reads without a
 * chart library.
 */
function UnitBranch({ node, depth }: { node: OrgNode; depth: number }) {
  const t = useT();
  const positions = node.positions;
  return (
    <li className="min-w-0">
      <div className="relative min-w-0">
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-7 -left-4 h-px w-4 bg-border"
          />
        )}
        <div className="grid min-w-0 gap-2 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold break-words">{node.unit.name}</p>
              <p className="text-xs leading-4 text-muted-foreground">
                {node.unit.code}
                {!node.unit.isActive && (
                  <>
                    {" · "}
                    {t("employeeMaster.organization.inactive")}
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">
                {t("employeeMaster.organization.directHeadcount", {
                  count: node.headcount,
                })}
              </Badge>
              {positions.length > 0 && (
                <Badge tone="info">
                  {t("employeeMaster.organization.positionCount", {
                    count: positions.length,
                  })}
                </Badge>
              )}
            </div>
          </div>
          {positions.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {positions.map((position) => (
                <li key={position.id}>
                  <Badge tone="neutral">{position.name}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {node.children.length > 0 && (
        <ul className="mt-3 ml-4 grid gap-3 border-l border-border pl-4">
          {node.children.map((child) => (
            <UnitBranch key={child.unit.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
