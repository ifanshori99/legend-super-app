// PTKP status of a tax year (bead 1223, SO 1221 A P2-1; PMK 168/2023).
//
// The PTKP of a tax year is the status on 1 January of that year, or on the
// join date when the employee starts during the year. A change in the middle
// of the year applies from the next tax year; the monthly TER category follows
// the same status. Read from `employee_ptkp_history`: the latest row in force
// on the anchor date, or the oldest row when none is that old (no history
// before the anchor). No history at all: the caller keeps its own value.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import type { PtkpStatus } from "@starter/shared/hris";
import { employeePtkpHistory } from "../db/schema/hris-ptkp-history.ts";
import type { Tx } from "./permission-resolver.ts";

/** 1 January of the tax year, or the join date when it is later. */
export function ptkpAnchorDate(taxYear: number, joinDate: string): string {
  const yearStart = `${taxYear}-01-01`;
  return joinDate > yearStart ? joinDate : yearStart;
}

/** Status of each employee for the tax year; absent when he has no history. */
export async function loadTaxYearPtkpStatuses(
  tx: Tx,
  tenantId: string,
  taxYear: number,
  members: readonly { id: string; joinDate: string }[],
): Promise<Map<string, PtkpStatus>> {
  const result = new Map<string, PtkpStatus>();
  if (members.length === 0) return result;
  const rows = await tx
    .select({
      employeeId: employeePtkpHistory.employeeId,
      effectiveFrom: employeePtkpHistory.effectiveFrom,
      ptkpStatus: employeePtkpHistory.ptkpStatus,
    })
    .from(employeePtkpHistory)
    .where(
      and(
        eq(employeePtkpHistory.tenantId, tenantId as TenantId),
        inArray(
          employeePtkpHistory.employeeId,
          members.map((m) => m.id) as never[],
        ),
      ),
    )
    .orderBy(asc(employeePtkpHistory.effectiveFrom));
  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }
  for (const member of members) {
    const history = byEmployee.get(member.id);
    if (!history || history.length === 0) continue;
    const anchor = ptkpAnchorDate(taxYear, member.joinDate);
    let chosen = history[0]!;
    for (const row of history) if (row.effectiveFrom <= anchor) chosen = row;
    result.set(member.id, chosen.ptkpStatus);
  }
  return result;
}
