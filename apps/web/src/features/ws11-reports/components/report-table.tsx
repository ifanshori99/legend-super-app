// The result table, in the shared list frame with its four states. Column
// headers are the registry names of the metric definitions (DASH-01), so a
// column always resolves to the definition behind it.
import { useT } from "@/components/i18n";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MetricCellView } from "@/features/ws11-owner-dashboard/components/metric-display";
import type { ReportResult } from "@starter/shared/dashboard";
import { useDimensionLabel, useDimensionValueLabel } from "./labels";

export function ReportTable({
  result,
  state,
  onRetry,
  empty,
}: {
  result: ReportResult | null;
  state: DataState;
  onRetry: () => void;
  empty?: { title: string; description: string };
}) {
  const t = useT();
  const dimensionLabel = useDimensionLabel();
  const valueLabel = useDimensionValueLabel();
  return (
    <DataTableShell
      title={t("reportViewer.table.title")}
      state={state}
      onRetry={onRetry}
      empty={empty}
      rowCount={result?.rows.length}
      loadingRows={5}
    >
      {result && (
        <Table>
          <TableHeader>
            <TableRow>
              {result.groupBy.length === 0 ? (
                <TableHead>{t("reportViewer.table.total")}</TableHead>
              ) : (
                result.groupBy.map((key) => (
                  <TableHead key={key}>{dimensionLabel(key)}</TableHead>
                ))
              )}
              {result.definitions.map((definition) => (
                <TableHead key={definition.code} numeric>
                  {definition.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row, index) => (
              <TableRow key={index}>
                {result.groupBy.length === 0 ? (
                  <TableCell className="font-medium">
                    {t("reportViewer.table.wholePeriod")}
                  </TableCell>
                ) : (
                  row.dimensions.map((dimension) => (
                    <TableCell key={dimension.key} className="font-medium">
                      {valueLabel(dimension.key, dimension.value)}
                    </TableCell>
                  ))
                )}
                {row.values.map((cell) => (
                  <TableCell key={cell.metricCode} numeric>
                    <MetricCellView value={cell.value} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DataTableShell>
  );
}
