import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EvalCase } from "./types.ts";

type OperationalEvalOptions = {
  tenantId: string;
  outletId: string;
  legalEntityId: string;
  actorUserId: string;
  caseUsers: ReadonlyMap<string, string>;
  entries: readonly EvalCase[];
};

/** Real SOP sources and employee identities for numeric evaluation cases.
 * The caller owns the tenant-scoped transaction.
 */
export async function seedOperationalEval(
  client: PoolClient,
  options: OperationalEvalOptions,
): Promise<void> {
  const { tenantId, outletId, legalEntityId, actorUserId, caseUsers } = options;
  const numeric = options.entries.filter(
    (entry) => entry.kind === "numeric" && caseUsers.has(entry.id),
  );

  const sopQueries = new Set(
    numeric
      .filter((entry) => entry.expectTool!.name === "search_sop")
      .map((entry) => String(entry.expectTool!.args.query)),
  );
  for (const query of sopQueries) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO sop_documents
         (id, tenant_id, lineage_id, version, title, body,
          requires_acknowledgement, effective_from, published_by)
       VALUES ($1, $2, $1, 1, $3, $4, false, '2025-01-01', $5)`,
      [
        id,
        tenantId,
        `SOP ${query}`,
        `Panduan ${query} untuk staf outlet.`,
        actorUserId,
      ],
    );
  }

  for (const entry of numeric.filter((item) => item.roleGroup === "employee")) {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees
         (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
          legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Staf evaluasi', $5, $6, 'pkwtt', '2025-01-01', 'active')`,
      [
        employeeId,
        tenantId,
        caseUsers.get(entry.id),
        `EV-${entry.id.toUpperCase()}`,
        outletId,
        legalEntityId,
      ],
    );
  }
}
