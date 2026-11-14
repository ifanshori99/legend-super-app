import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EvalCase } from "./types.ts";

type ProfitShareEvalOptions = {
  tenantId: string;
  legalEntityId: string;
  outletId: string;
  actorUserId: string;
  caseUsers: ReadonlyMap<string, string>;
  entries: readonly EvalCase[];
};

// Fixed figures: 1.0e9 net profit in 2025, +100 million per later year, 10%
// reserve. Distributable (0.9e9 + 90 million per year) is a multiple of 10,000,
// so every basis-point share is a whole rupiah and the lines add up exactly.
const BASE_NET_PROFIT_IDR = 1_000_000_000;
const NET_PROFIT_STEP_IDR = 100_000_000;
const RESERVE_BP = 1000;
const BASE_SHARE_BP = 1000;
const YEAR_SHARE_STEP_BP = 200;
const HOLDER_SHARE_STEP_BP = 150;

/** Real approved shares and paid distribution lines for profit-share eval cases.
 * One closed period (June), one approved share version and one approved run per
 * year asked; each case user holds a share of it and has a paid line, while a
 * comparison shareholder keeps the rest and stays unpaid. Tax withheld is 0.
 * Call after the financial seed; the caller owns the tenant-scoped transaction.
 */
export async function seedProfitShareEval(
  client: PoolClient,
  options: ProfitShareEvalOptions,
): Promise<void> {
  const { tenantId, legalEntityId, actorUserId, caseUsers } = options;

  // Case users per requested year, in case-id order so values stay stable.
  const usersByYear = new Map<number, string[]>();
  for (const entry of [...options.entries].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const userId = caseUsers.get(entry.id);
    if (
      entry.kind !== "numeric" ||
      userId === undefined ||
      entry.expectTool?.name !== "get_my_profit_share"
    )
      continue;
    const year = Number(entry.expectTool.args.year);
    const users = usersByYear.get(year) ?? [];
    if (!users.includes(userId)) users.push(userId);
    usersByYear.set(year, users);
  }
  if (usersByYear.size === 0) return;

  const entityId = randomUUID();
  await client.query(
    `INSERT INTO profit_entities
       (tenant_id, id, name, type, legal_entity_id, reserve_bp, frequency,
        tax_withholding_bp, created_by)
     VALUES ($1, $2, 'Entitas evaluasi', 'legal_entity', $3, $4, 'monthly', 0, $5)`,
    [tenantId, entityId, legalEntityId, RESERVE_BP, actorUserId],
  );

  const shareholderIds = new Map<string, string>();
  const insertShareholder = async (name: string, userId: string | null) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO shareholders (tenant_id, id, user_id, name, type, created_by)
       VALUES ($1, $2, $3, $4, 'person', $5)`,
      [tenantId, id, userId, name, actorUserId],
    );
    return id;
  };
  const restHolderId = await insertShareholder("Pembanding evaluasi", null);
  for (const users of usersByYear.values())
    for (const userId of users)
      shareholderIds.set(
        userId,
        await insertShareholder("Pemegang evaluasi", userId),
      );

  const approverId = randomUUID();
  const years = [...usersByYear.keys()].sort((a, b) => a - b);
  for (const [index, year] of years.entries()) {
    const version = index + 1;
    const users = usersByYear.get(year)!;
    const yearStep = year - 2025;
    const userBp = users.map(
      (_, position) =>
        BASE_SHARE_BP +
        yearStep * YEAR_SHARE_STEP_BP +
        position * HOLDER_SHARE_STEP_BP,
    );
    const restBp = 10_000 - userBp.reduce((sum, bp) => sum + bp, 0);
    if (restBp <= 0) throw new RangeError(`Shares exceed 100% in ${year}`);
    const holders = [
      ...users.map((userId, position) => ({
        shareholderId: shareholderIds.get(userId)!,
        userId,
        bp: userBp[position]!,
      })),
      { shareholderId: restHolderId, userId: null, bp: restBp },
    ];

    // Approved share version: draft -> pending -> approved (deferred sum check
    // sees exactly 10,000 bp at commit).
    await client.query(
      `INSERT INTO share_allocation_versions
         (tenant_id, profit_entity_id, version, effective_from, status,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
      [
        tenantId,
        entityId,
        version,
        `${year}-01-01`,
        actorUserId,
        `eval-ver-${year}`,
      ],
    );
    for (const [position, holder] of holders.entries())
      await client.query(
        `INSERT INTO share_allocations
           (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          entityId,
          version,
          holder.shareholderId,
          holder.bp,
          position,
        ],
      );
    await client.query(
      `UPDATE share_allocation_versions SET status = 'pending_approval'
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
      [tenantId, entityId, version],
    );
    await client.query(
      `UPDATE share_allocation_versions
          SET status = 'approved', decided_by = $4, decided_at = $5
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
      [tenantId, entityId, version, approverId, `${year}-01-02T03:00:00Z`],
    );

    // Closed June period of the year (the financial seed uses other months).
    const period = `${year}-06`;
    const periodId = randomUUID();
    await client.query(
      `INSERT INTO fiscal_periods
         (id, tenant_id, legal_entity_id, period, status, closed_by, closed_at)
       VALUES ($1, $2, $3, $4, 'closed', $5, $6)`,
      [
        periodId,
        tenantId,
        legalEntityId,
        period,
        actorUserId,
        `${year}-07-01T03:00:00Z`,
      ],
    );

    const netProfit = BASE_NET_PROFIT_IDR + yearStep * NET_PROFIT_STEP_IDR;
    const reserve = (netProfit * RESERVE_BP) / 10_000;
    const distributable = netProfit - reserve;
    const gross = (bp: number) => (distributable / 10_000) * bp;
    const runId = randomUUID();
    await client.query(
      `INSERT INTO distribution_runs
         (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version,
          period, type, basis, status, share_version, period_net_profit_idr,
          reserve_idr, distributable_idr, total_gross_idr, total_tax_withheld_idr,
          total_net_idr, unabsorbed_idr, carry_deducted_idr, tax_withholding_bp,
          requested_by, requested_at, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, $5, 'regular', 'closed_period_net_profit',
               'draft', $6, $7, $8, $9, $9, 0, $9, 0, 0, 0, $10, $11, $12)`,
      [
        tenantId,
        runId,
        entityId,
        periodId,
        period,
        version,
        netProfit,
        reserve,
        distributable,
        actorUserId,
        `${year}-07-02T03:00:00Z`,
        `eval-run-${year}`,
      ],
    );
    for (const [position, holder] of holders.entries())
      await client.query(
        `INSERT INTO distribution_lines
           (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr,
            tax_withheld_idr, net_idr, recipient_user_id, position)
         VALUES ($1, $2, $3, $4, $5, 0, $5, $6, $7)`,
        [
          tenantId,
          runId,
          holder.shareholderId,
          holder.bp,
          gross(holder.bp),
          holder.userId,
          position,
        ],
      );
    await client.query(
      `UPDATE distribution_runs SET status = 'pending_approval'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    await client.query(
      `UPDATE distribution_runs
          SET status = 'approved', approved_by = $3, approved_at = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId, approverId, `${year}-07-03T03:00:00Z`],
    );
    // Pay only the case users' lines. The comparison line stays pending, so the
    // run is validly "approved" (a run with every line paid would be "paid" and
    // need a posted journal).
    for (const holder of holders)
      if (holder.userId !== null)
        await client.query(
          `UPDATE distribution_lines
              SET payment_status = 'paid', payment_ref = $4, paid_at = $5, paid_by = $6
            WHERE tenant_id = $1 AND distribution_run_id = $2 AND shareholder_id = $3`,
          [
            tenantId,
            runId,
            holder.shareholderId,
            `EV-PS-${year}`,
            `${year}-07-04T03:00:00Z`,
            approverId,
          ],
        );
  }
}
