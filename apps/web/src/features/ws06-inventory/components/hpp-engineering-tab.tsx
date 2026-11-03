// Menu engineering (PRD §17 "Menu Engineering"): the server's four-way
// classification of popularity and margin, a 2x2 matrix with the count in each
// cell, and the row table. The matrix cells filter the table; they never
// reclassify a menu — the classification comes from the report endpoint.
import * as React from "react";
import { X } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill, type StatusKind } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MenuEngineeringClass } from "@starter/shared/inventory";
import { useMenuEngineering } from "../hpp-hooks";
import {
  engineeringCounts,
  menuNameOf,
  periodLabel,
  sortMenuEngineering,
  type HppPeriod,
} from "../hpp-lib";

const CLASS_LABEL = {
  star: "inventoryHpp.engineering.classes.star",
  plowhorse: "inventoryHpp.engineering.classes.plowhorse",
  puzzle: "inventoryHpp.engineering.classes.puzzle",
  dog: "inventoryHpp.engineering.classes.dog",
} as const satisfies Record<MenuEngineeringClass, string>;

const CLASS_HINT = {
  star: "inventoryHpp.engineering.classHints.star",
  plowhorse: "inventoryHpp.engineering.classHints.plowhorse",
  puzzle: "inventoryHpp.engineering.classHints.puzzle",
  dog: "inventoryHpp.engineering.classHints.dog",
} as const satisfies Record<MenuEngineeringClass, string>;

// Classification is a business meaning: star needs no action, dog does.
const CLASS_STATUS: Record<MenuEngineeringClass, StatusKind> = {
  star: "success",
  plowhorse: "info",
  puzzle: "warning",
  dog: "danger",
};

export function HppEngineeringTab({ period }: { period: HppPeriod }) {
  const t = useT();
  const query = useMenuEngineering(period);
  const [selected, setSelected] = React.useState<MenuEngineeringClass | null>(
    null,
  );

  const rows = React.useMemo(
    () => sortMenuEngineering(query.data?.data ?? []),
    [query.data],
  );
  const counts = React.useMemo(() => engineeringCounts(rows), [rows]);
  const filtered = selected
    ? rows.filter((row) => row.classification === selected)
    : rows;

  const state: DataState = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : filtered.length === 0
          ? "empty"
          : "ready";

  if (query.isPending || query.isError || rows.length === 0) {
    return (
      <DataTableShell
        title={t("inventoryHpp.engineering.title")}
        description={t("inventoryHpp.engineering.description")}
        state={state}
        onRetry={() => void query.refetch()}
        empty={{
          title: t("inventoryHpp.engineering.emptyTitle"),
          description: t("inventoryHpp.engineering.emptyHint"),
        }}
        loadingRows={4}
      />
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <CardShell>
        <CardShellBody className="gap-3 p-card">
          <div className="grid gap-0.5">
            <p className="type-eyebrow text-muted-foreground">
              {periodLabel(period)}
            </p>
            <h3 className="type-title">
              {t("inventoryHpp.engineering.matrixTitle")}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryHpp.engineering.matrixHint")}
            </p>
          </div>
          <EngineeringMatrix
            counts={counts}
            selected={selected}
            onSelect={(value) =>
              setSelected((current) => (current === value ? null : value))
            }
          />
        </CardShellBody>
      </CardShell>

      <DataTableShell
        title={t("inventoryHpp.engineering.title")}
        description={
          selected
            ? t("inventoryHpp.engineering.filteredBy", {
                classification: t(CLASS_LABEL[selected]),
              })
            : t("inventoryHpp.engineering.description")
        }
        state={state}
        onRetry={() => void query.refetch()}
        actions={
          selected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(null)}
            >
              <X aria-hidden="true" />
              {t("inventoryHpp.engineering.clearFilter")}
            </Button>
          ) : undefined
        }
        empty={{
          title: t("inventoryHpp.engineering.filterEmptyTitle"),
          description: t("inventoryHpp.engineering.filterEmptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(null)}
            >
              {t("inventoryHpp.engineering.clearFilter")}
            </Button>
          ),
        }}
        rowCount={filtered.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("inventoryHpp.engineering.columns.menu")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.engineering.columns.units")}
              </TableHead>
              <TableHead numeric>
                {t("inventoryHpp.engineering.columns.margin")}
              </TableHead>
              <TableHead>
                {t("inventoryHpp.engineering.columns.classification")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.menuItemId}>
                <TableCell className="font-medium">
                  {menuNameOf(row.menuItemId)}
                </TableCell>
                <TableCell numeric>
                  <NumberDisplay value={row.unitsSold} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={row.grossMarginIdr} />
                </TableCell>
                <TableCell>
                  <StatusPill status={CLASS_STATUS[row.classification]}>
                    {t(CLASS_LABEL[row.classification])}
                  </StatusPill>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}

function EngineeringMatrix({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<MenuEngineeringClass, number>;
  selected: MenuEngineeringClass | null;
  onSelect: (value: MenuEngineeringClass) => void;
}) {
  const t = useT();
  const cell = (value: MenuEngineeringClass) => (
    <MatrixCell
      value={value}
      count={counts[value]}
      selected={selected === value}
      onSelect={onSelect}
    />
  );
  // Two cells per row on a phone: the axis labels would otherwise steal the
  // width they need. The labelled 2x2 starts at sm.
  return (
    <div
      role="group"
      aria-label={t("inventoryHpp.engineering.matrixTitle")}
      className="grid grid-cols-2 items-stretch gap-2 sm:grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div aria-hidden="true" className="hidden sm:block" />
      <p className="hidden text-center text-xs leading-4 text-muted-foreground sm:block">
        {t("inventoryHpp.engineering.axis.popular")}
      </p>
      <p className="hidden text-center text-xs leading-4 text-muted-foreground sm:block">
        {t("inventoryHpp.engineering.axis.unpopular")}
      </p>

      <p className="hidden self-center text-xs leading-4 text-muted-foreground sm:block">
        {t("inventoryHpp.engineering.axis.marginHigh")}
      </p>
      {cell("star")}
      {cell("puzzle")}

      <p className="hidden self-center text-xs leading-4 text-muted-foreground sm:block">
        {t("inventoryHpp.engineering.axis.marginLow")}
      </p>
      {cell("plowhorse")}
      {cell("dog")}
    </div>
  );
}

function MatrixCell({
  value,
  count,
  selected,
  onSelect,
}: {
  value: MenuEngineeringClass;
  count: number;
  selected: boolean;
  onSelect: (value: MenuEngineeringClass) => void;
}) {
  const t = useT();
  return (
    // A matrix cell is a filter, so it selects in ink, never accent
    // (DESIGN.md §2 accent budget: tabs and filters select in ink).
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(value)}
      className={
        selected
          ? "grid min-w-0 gap-1 rounded-container border-(length:--border-w) border-foreground bg-surface-2 p-3 text-left ring-1 ring-foreground transition-colors duration-(--duration-fast) sm:p-card"
          : "grid min-w-0 gap-1 rounded-container border-(length:--border-w) border-border bg-card p-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-2 sm:p-card"
      }
    >
      <span className="type-heading">{t(CLASS_LABEL[value])}</span>
      <span className="type-title tabular">
        {t("inventoryHpp.engineering.matrixCount", { count })}
      </span>
      <span className="text-xs leading-4 text-muted-foreground">
        {t(CLASS_HINT[value])}
      </span>
    </button>
  );
}
