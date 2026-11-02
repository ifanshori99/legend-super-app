// Read-only parameter rows of a statutory version, and the version diff that
// compares two of them. Both use the same flattened rows from lib.ts, so a new
// table type gets a label in the catalog instead of a component change.
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ParameterDiff,
  ParameterRow,
  ParameterValueKind,
} from "../lib";
import { formatBasisPoints, formatMultiplierInput } from "../lib";

type Translate = ReturnType<typeof useT>;

function rowLabel(
  row: {
    labelKey: ParameterRow["labelKey"];
    labelVars?: ParameterRow["labelVars"];
    varKeys?: ParameterRow["varKeys"];
  },
  t: Translate,
): string {
  const vars: Record<string, string | number> = { ...row.labelVars };
  for (const [name, key] of Object.entries(row.varKeys ?? {}))
    vars[name] = t(key);
  return t(row.labelKey, vars);
}

function ParameterValue({
  kind,
  value,
  enumKey,
  nullKey,
  t,
}: {
  kind: ParameterValueKind;
  value: ParameterRow["value"];
  enumKey?: ParameterRow["enumKey"];
  nullKey?: ParameterRow["nullKey"];
  t: Translate;
}) {
  if (value === null)
    return (
      <span className="text-sm text-muted-foreground">
        {t(nullKey ?? "payrollConfig.statutory.parameterLabels.unset")}
      </span>
    );
  switch (kind) {
    case "amount":
      return <Money amount={Number(value)} />;
    case "rate":
      return (
        <span className="tabular">{formatBasisPoints(Number(value))}</span>
      );
    case "decimal":
      return (
        <span className="tabular">{formatMultiplierInput(String(value))}</span>
      );
    case "count":
      return <NumberDisplay value={Number(value)} />;
    case "text":
      return <>{enumKey ? t(enumKey) : String(value)}</>;
  }
}

export function StatutoryParameterTable({ rows }: { rows: ParameterRow[] }) {
  const t = useT();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("payrollConfig.statutory.detailDialog.parameters")}</TableHead>
          <TableHead numeric>
            {t("payrollConfig.statutory.detailDialog.value")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="max-w-72 whitespace-normal">
              {rowLabel(row, t)}
            </TableCell>
            <TableCell numeric>
              <ParameterValue
                kind={row.kind}
                value={row.value}
                enumKey={row.enumKey}
                nullKey={row.nullKey}
                t={t}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function StatutoryDiffTable({
  rows,
  fromVersion,
  toVersion,
}: {
  rows: ParameterDiff[];
  fromVersion: number;
  toVersion: number;
}) {
  const t = useT();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            {t("payrollConfig.statutory.compareDialog.columns.field")}
          </TableHead>
          <TableHead numeric>
            {t("payrollConfig.statutory.compareDialog.columns.from", {
              version: fromVersion,
            })}
          </TableHead>
          <TableHead numeric>
            {t("payrollConfig.statutory.compareDialog.columns.to", {
              version: toVersion,
            })}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.key}
            className={row.changed ? "bg-warning-subtle" : undefined}
          >
            <TableCell className="max-w-64 whitespace-normal">
              <span className="flex flex-wrap items-center gap-1.5">
                {rowLabel(row, t)}
                {row.changed && (
                  <Badge tone="warning">
                    {t("payrollConfig.statutory.compareDialog.changed")}
                  </Badge>
                )}
              </span>
            </TableCell>
            <TableCell numeric>
              <ParameterValue
                kind={row.kind}
                value={row.from}
                enumKey={row.enumKey}
                nullKey={row.nullKey}
                t={t}
              />
            </TableCell>
            <TableCell numeric>
              <ParameterValue
                kind={row.kind}
                value={row.to}
                enumKey={row.enumKey}
                nullKey={row.nullKey}
                t={t}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
