// AP/AR + aging, fixed assets (depreciation, revaluation, disposal) and
// budgets vs actual — HTTP + service integration tests (bead legend-hpgo;
// PRD v1.7 §3.19 "Utang & Piutang", "Aset Tetap", "Anggaran", Jurnal
// Otomatis "depresiasi"; ACC-01, ACC-02, ACC-03; TEN-01/02/03). Runs the real
// Express app, Better Auth and PostgreSQL against the disposable test DB.
//
// Requires the squad lead's wiring: the bead migration (schema
// accounting-ap-fa.ts + accounting-ap-fa.custom.sql) and the router mounted
// with `apiRouter.use("/accounting", createAccountingApFaRouter())`.
//
// Every test owns a fresh legal entity (journals are append-only), so rows
// from one test never leak into another.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  idr,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  accountIdSchema,
  defaultPostingRules,
  POSTING_ACCOUNT_ROLES,
} from "@starter/shared/accounting";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  paySupplierInvoiceInTransaction,
  recordSupplierInvoicePayableInTransaction,
} from "../services/accounting-ap.service";
import {
  recordReceivableInTransaction,
  settleReceivableInTransaction,
} from "../services/accounting-ar.service";
import { getAgingReport as getAgingReportService } from "../services/accounting-open-items.service";
import {
  createFixedAsset,
  disposeFixedAsset,
  getFixedAsset,
  listDepreciationRuns,
  listFixedAssets,
  revalueFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";
import {
  getBudgetVsActual,
  listBudgets,
} from "../services/accounting-budgets.service";
import {
  depreciationJobKey,
  runDueDepreciation,
} from "../worker/accounting-depreciation.job";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const outletB = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
/** Fixed "now" for service calls: every test date below is in the past. */
const NOW = new Date("2026-11-03T03:00:00Z");
const actor: UserId = userIdSchema.parse(randomUUID());
const hasRevaluationRule = defaultPostingRules.some(
  (rule) => rule.key === "document:asset_revaluation",
);

function tenantScope(tenant = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function outletScope(...outlets: string[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outlets.map((id) => outletIdSchema.parse(id)),
    },
  );
}

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

type Ledger = Record<
  | "bank"
  | "receivable"
  | "fixedAssets"
  | "accumulated"
  | "payable"
  | "surplus"
  | "revenue"
  | "depreciationExpense"
  | "electricity"
  | "revaluationLoss"
  | "disposalResult",
  string
>;

/** A small chart + the posting-role mappings this bead posts through. */
async function setupLedger(entity: string): Promise<Ledger> {
  const rows: [keyof Ledger, string, string, string, string][] = [
    ["bank", "1103", "Bank Operasional", "asset", "cash_and_equivalents"],
    ["receivable", "1201", "Piutang Usaha", "asset", "current_asset"],
    ["fixedAssets", "1501", "Aset Tetap", "asset", "non_current_asset"],
    [
      "accumulated",
      "1502",
      "Akumulasi Penyusutan",
      "asset",
      "non_current_asset",
    ],
    ["payable", "2101", "Utang Usaha", "liability", "current_liability"],
    ["surplus", "3201", "Surplus Revaluasi", "equity", "equity"],
    ["revenue", "4101", "Penjualan", "revenue", "revenue"],
    [
      "disposalResult",
      "7101",
      "Laba/Rugi Pelepasan Aset",
      "revenue",
      "other_income",
    ],
    [
      "depreciationExpense",
      "6101",
      "Beban Penyusutan",
      "expense",
      "operating_expense",
    ],
    ["electricity", "6201", "Beban Listrik", "expense", "operating_expense"],
    ["revaluationLoss", "6102", "Rugi Revaluasi", "expense", "other_expense"],
  ];
  const ledger = {} as Ledger;
  for (const [name, code, label, type, group] of rows) {
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, label, type, group],
    );
    ledger[name] = inserted[0]!.id;
  }
  const mappings: [string, keyof Ledger][] = [
    ["bank", "bank"],
    ["accounts_receivable", "receivable"],
    ["fixed_assets", "fixedAssets"],
    ["accumulated_depreciation", "accumulated"],
    ["accounts_payable", "payable"],
    ["depreciation_expense", "depreciationExpense"],
    ["asset_disposal_result", "disposalResult"],
    // Proposed contract roles for the revaluation rule (bead report); mapped
    // only once the contract knows them, so other postings keep parsing.
    ["revaluation_surplus", "surplus"],
    ["asset_revaluation_loss", "revaluationLoss"],
  ];
  for (const [role, account] of mappings) {
    if (!(role in POSTING_ACCOUNT_ROLES)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, ledger[account]],
    );
  }
  return ledger;
}

async function closePeriod(entity: string, period: string): Promise<void> {
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
     VALUES ($1, $2, $3, 'closed', $4, now())
     ON CONFLICT (tenant_id, legal_entity_id, period)
     DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now()`,
    [tenantId, entity, period, actor],
  );
}

type Line = {
  account_id: string;
  debit_idr: string;
  credit_idr: string;
  outlet_id: string | null;
};

async function journalLinesOf(entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<Line>(
    `SELECT account_id, debit_idr, credit_idr, outlet_id FROM journal_lines
      WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no`,
    [tenantId, entryId],
  );
  return rows;
}

const side = (lines: Line[], account: string, outlet: string | null = null) =>
  lines
    .filter((row) => row.account_id === account && row.outlet_id === outlet)
    .map((row) => [Number(row.debit_idr), Number(row.credit_idr)]);

async function asset(
  entity: string,
  input: Partial<{
    outletId: string | null;
    name: string;
    acquiredOn: string;
    costIdr: number;
    residualValueIdr: number;
    usefulLifeMonths: number;
    depreciationStartPeriod: string;
    sourceDocumentId: string | null;
  }> = {},
  context = tenantScope(),
) {
  return createFixedAsset(
    context,
    {
      legalEntityId: entity,
      outletId: outletA,
      name: "Mesin espresso",
      acquiredOn: "2026-01-05",
      costIdr: 12_000_000,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-01",
      sourceDocumentId: null,
      idempotencyKey: key("fa"),
      ...input,
    },
    actor,
    NOW,
  );
}

const run = (entity: string, period: string, idempotencyKey = key("run")) =>
  runDepreciation(
    tenantScope(),
    { legalEntityId: entity, period, idempotencyKey },
    actor,
    NOW,
  );

async function signedIn(name = "AP/FA user") {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function financeUser() {
  const { client, userId } = await signedIn("Finance AP/FA");
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
  return { client, userId };
}

async function auditCount(action: string, objectId: string): Promise<number> {
  const { rowCount } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenantId, action, objectId],
  );
  return rowCount ?? 0;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (otherTenantIds.length > 0) {
    for (const table of [
      "fixed_assets",
      "budgets",
      "accounting_open_items",
      "chart_of_accounts",
      "legal_entities",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`,
        [otherTenantIds],
      );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-hpgo fixed assets and depreciation (§3.19 Aset Tetap)", () => {
  it("ACC-01 §3.19 depreciation run posts one balanced journal with a pair per outlet; the schedule rounds to exactly cost − residual", async () => {
    const entity = await createEntity("FA run");
    const ledger = await setupLedger(entity);
    // 10,000,000 over 3 months: largest remainder → 3,333,334 + 3,333,333 + 3,333,333.
    const odd = await asset(entity, {
      costIdr: 10_000_001,
      residualValueIdr: 1,
      usefulLifeMonths: 3,
    });
    const entityLevel = await asset(entity, {
      outletId: null,
      costIdr: 1_200_000,
      usefulLifeMonths: 12,
    });

    const detail = await getFixedAsset(tenantScope(), odd.id);
    expect(detail.schedule.map((row) => row.amountIdr)).toEqual([
      3_333_334, 3_333_333, 3_333_333,
    ]);

    const january = await run(entity, "2026-01");
    expect(january.amountIdr).toBe(3_333_334 + 100_000);
    expect(january.journalEntryId).not.toBeNull();
    expect(
      january.lines.map((line) => [line.fixedAssetId, line.amountIdr]).sort(),
    ).toEqual(
      [
        [odd.id, 3_333_334],
        [entityLevel.id, 100_000],
      ].sort(),
    );
    const lines = await journalLinesOf(january.journalEntryId!);
    // ACC-03: outlet P&L keeps the outlet asset's expense on its outlet.
    expect(side(lines, ledger.depreciationExpense, outletA)).toEqual([
      [3_333_334, 0],
    ]);
    expect(side(lines, ledger.accumulated, outletA)).toEqual([[0, 3_333_334]]);
    expect(side(lines, ledger.depreciationExpense, null)).toEqual([
      [100_000, 0],
    ]);
    expect(side(lines, ledger.accumulated, null)).toEqual([[0, 100_000]]);
    const debit = lines.reduce((sum, row) => sum + Number(row.debit_idr), 0);
    const credit = lines.reduce((sum, row) => sum + Number(row.credit_idr), 0);
    expect(debit).toBe(credit);

    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const after = await getFixedAsset(tenantScope(), odd.id);
    expect(after.asset.accumulatedDepreciationIdr).toBe(10_000_000);
    expect(after.asset.status).toBe("fully_depreciated");
    const { rows } = await owner.query<{ total: string }>(
      `SELECT sum(amount_idr) AS total FROM fixed_asset_depreciations
        WHERE tenant_id = $1 AND fixed_asset_id = $2`,
      [tenantId, odd.id],
    );
    expect(Number(rows[0]?.total)).toBe(10_000_001 - 1);

    // A fully depreciated asset carries nothing in April.
    const april = await run(entity, "2026-04");
    expect(april.lines.map((line) => line.fixedAssetId)).toEqual([
      entityLevel.id,
    ]);

    const outbox = await owner.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'depreciation_run.posted'
          AND event->'payload'->>'depreciationRunId' = $2`,
      [tenantId, january.id],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].event.payload.amountIdr).toBe(3_433_334);
    expect(
      await auditCount("accounting.depreciation_run.posted", january.id),
    ).toBe(1);

    const listed = await listDepreciationRuns(tenantScope(), entity);
    expect(listed.data.map((item) => item.period)).toEqual([
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01",
    ]);
  });

  it("§3.19 depreciation is idempotent per asset+period: key replay, conflicting fingerprint and a second run of a period", async () => {
    const entity = await createEntity("FA idempotency");
    await setupLedger(entity);
    await asset(entity);
    const runKey = key("run");
    const first = await run(entity, "2026-01", runKey);
    const replay = await run(entity, "2026-01", runKey);
    expect(replay).toEqual(first);

    await expect(run(entity, "2026-02", runKey)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(run(entity, "2026-01")).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });

    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'depreciation'`,
      [tenantId, entity],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    await expect(
      owner.query(
        `INSERT INTO fixed_asset_depreciations (tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id)
         SELECT tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id
           FROM fixed_asset_depreciations WHERE run_id = $1`,
        [first.id],
      ),
    ).rejects.toThrow(/DEPRECIATION_ALREADY_POSTED/);
  });

  it("ACC-02 a run into a closed month is refused; the next open run catches the month up", async () => {
    const entity = await createEntity("FA closed period");
    await setupLedger(entity);
    const backdated = await asset(entity, {
      acquiredOn: "2026-04-02",
      depreciationStartPeriod: "2026-04",
    });
    await closePeriod(entity, "2026-04");
    await expect(run(entity, "2026-04")).rejects.toMatchObject({
      code: "PERIOD_CLOSED",
    });
    const { rows: none } = await owner.query(
      "SELECT 1 FROM depreciation_runs WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity],
    );
    expect(none).toEqual([]);

    const may = await run(entity, "2026-05");
    expect(may.lines).toEqual([
      { fixedAssetId: backdated.id, amountIdr: 2_000_000 },
    ]);
    const { rows } = await owner.query<{ period: string }>(
      `SELECT period FROM fixed_asset_depreciations
        WHERE tenant_id = $1 AND fixed_asset_id = $2 ORDER BY period`,
      [tenantId, backdated.id],
    );
    expect(rows.map((row) => row.period)).toEqual(["2026-04", "2026-05"]);
    const { rows: entry } = await owner.query<{ entry_date: string }>(
      "SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE id = $1",
      [may.journalEntryId],
    );
    expect(entry[0]?.entry_date).toBe("2026-05-31");
  });

  it("§3.19 registration from a purchase posts debit fixed assets / credit AP; a closed acquisition month is refused (ACC-02)", async () => {
    const entity = await createEntity("FA acquisition");
    const ledger = await setupLedger(entity);
    const purchased = await asset(entity, {
      acquiredOn: "2026-06-10",
      depreciationStartPeriod: "2026-07",
      sourceDocumentId: randomUUID(),
    });
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND source_type = 'asset_acquisition' AND source_id = $2`,
      [tenantId, purchased.id],
    );
    expect(rows).toHaveLength(1);
    const lines = await journalLinesOf(rows[0]!.id);
    expect(side(lines, ledger.fixedAssets, outletA)).toEqual([[12_000_000, 0]]);
    expect(side(lines, ledger.payable, outletA)).toEqual([[0, 12_000_000]]);
    expect(
      await auditCount("accounting.fixed_asset.created", purchased.id),
    ).toBe(1);

    await closePeriod(entity, "2026-08");
    await expect(
      asset(entity, {
        acquiredOn: "2026-08-03",
        depreciationStartPeriod: "2026-09",
        sourceDocumentId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
    const { rows: assets } = await owner.query(
      "SELECT 1 FROM fixed_assets WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity],
    );
    expect(assets).toHaveLength(1);

    // Input rules before any write.
    await expect(
      asset(entity, { residualValueIdr: 12_000_000 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      asset(entity, {
        acquiredOn: "2026-03-01",
        depreciationStartPeriod: "2026-02",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("§3.19 disposal posts the gain/loss journal after catching up the disposal month; audited; disposed once", async () => {
    const entity = await createEntity("FA disposal");
    const ledger = await setupLedger(entity);
    const sold = await asset(entity);
    const scrapped = await asset(entity, { costIdr: 2_400_000 });
    await run(entity, "2026-01");
    await run(entity, "2026-02");

    // Gain: carrying 12,000,000 − 3,000,000 (Jan–Mar) = 9,000,000; sold 9,500,000.
    const disposed = await disposeFixedAsset(
      tenantScope(),
      sold.id,
      {
        disposedOn: "2026-03-15",
        proceedsIdr: 9_500_000,
        reason: "Dijual ke pihak ketiga",
        idempotencyKey: key("disp"),
      },
      actor,
      NOW,
    );
    expect(disposed.status).toBe("disposed");
    expect(disposed.accumulatedDepreciationIdr).toBe(3_000_000);
    expect(disposed.disposalProceedsIdr).toBe(9_500_000);
    const { rows: entries } = await owner.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND source_type = 'asset_disposal' AND source_id = $2`,
      [tenantId, sold.id],
    );
    const lines = await journalLinesOf(entries[0]!.id);
    expect(side(lines, ledger.bank, outletA)).toEqual([[9_500_000, 0]]);
    expect(side(lines, ledger.accumulated, outletA)).toEqual([[3_000_000, 0]]);
    expect(side(lines, ledger.fixedAssets, outletA)).toEqual([[0, 12_000_000]]);
    expect(side(lines, ledger.disposalResult, outletA)).toEqual([[0, 500_000]]);
    expect(await auditCount("accounting.fixed_asset.disposed", sold.id)).toBe(
      1,
    );

    // Loss: scrapped for nothing → the carrying amount is debited as a loss.
    await disposeFixedAsset(
      tenantScope(),
      scrapped.id,
      {
        disposedOn: "2026-02-20",
        proceedsIdr: 0,
        reason: "Rusak, tidak dapat diperbaiki",
        idempotencyKey: key("disp"),
      },
      actor,
      NOW,
    );
    const { rows: lossEntries } = await owner.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND source_type = 'asset_disposal' AND source_id = $2`,
      [tenantId, scrapped.id],
    );
    const lossLines = await journalLinesOf(lossEntries[0]!.id);
    expect(side(lossLines, ledger.bank, outletA)).toEqual([]);
    expect(side(lossLines, ledger.accumulated, outletA)).toEqual([
      [400_000, 0],
    ]);
    expect(side(lossLines, ledger.disposalResult, outletA)).toEqual([
      [2_000_000, 0],
    ]);

    await expect(
      disposeFixedAsset(
        tenantScope(),
        sold.id,
        {
          disposedOn: "2026-03-20",
          proceedsIdr: 1,
          reason: "Kedua kali",
          idempotencyKey: key("disp"),
        },
        actor,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "ASSET_ALREADY_DISPOSED", status: 409 });

    // March was caught up by the disposal: the March run posts nothing twice.
    const march = await run(entity, "2026-03");
    expect(march.amountIdr).toBe(0);
    expect(march.journalEntryId).toBeNull();
  });

  it("ACC-01 §3.19 a disposal/revaluation dated before an already-posted run reverses the later months instead of keeping phantom depreciation (legend-i5kc)", async () => {
    const entity = await createEntity("FA backdated");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");

    // March's charge is reversed: February carrying amount (10,000,000) is
    // revalued to itself, so the schedule restarts in March on that base.
    const revalued = await revalueFixedAsset(
      tenantScope(),
      machine.id,
      {
        revaluedOn: "2026-02-25",
        newCarryingAmountIdr: 10_000_000,
        reason: "Penilaian mundur",
        idempotencyKey: key("reval"),
      },
      actor,
      NOW,
    );
    expect(revalued.costIdr).toBe(10_000_000);
    expect(revalued.accumulatedDepreciationIdr).toBe(0);
    const { rows: reversals } = await owner.query(
      `SELECT 1 FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2
          AND source_type = 'depreciation' AND description LIKE 'Koreksi penyusutan%'`,
      [tenantId, entity],
    );
    expect(reversals).toHaveLength(1);

    // March depreciates again on the new base (10,000,000 over 10 months):
    // carrying 9,000,000, sold at it.
    const sold = await disposeFixedAsset(
      tenantScope(),
      machine.id,
      {
        disposedOn: "2026-03-15",
        proceedsIdr: 9_000_000,
        reason: "Dijual Maret",
        idempotencyKey: key("disp"),
      },
      actor,
      NOW,
    );
    expect(sold.status).toBe("disposed");
    expect(sold.accumulatedDepreciationIdr).toBe(1_000_000);
    expect(sold.bookValueIdr).toBe(9_000_000);
  });

  it.runIf(hasRevaluationRule)(
    "§3.19 revaluation eliminates accumulated depreciation, books the surplus and re-spreads the new base; audited",
    async () => {
      const entity = await createEntity("FA revaluation");
      const ledger = await setupLedger(entity);
      const revalued = await asset(entity);
      await run(entity, "2026-01");
      await run(entity, "2026-02");
      const result = await revalueFixedAsset(
        tenantScope(),
        revalued.id,
        {
          revaluedOn: "2026-02-25",
          newCarryingAmountIdr: 12_000_000,
          reason: "Penilaian KJPP",
          idempotencyKey: key("reval"),
        },
        actor,
        NOW,
      );
      expect(result.costIdr).toBe(12_000_000);
      expect(result.accumulatedDepreciationIdr).toBe(0);
      expect(result.usefulLifeMonths).toBe(10);
      expect(result.depreciationStartPeriod).toBe("2026-03");
      const { rows } = await owner.query<{ journal_entry_id: string }>(
        "SELECT journal_entry_id FROM fixed_asset_revaluations WHERE tenant_id = $1 AND fixed_asset_id = $2",
        [tenantId, revalued.id],
      );
      const lines = await journalLinesOf(rows[0]!.journal_entry_id);
      expect(side(lines, ledger.accumulated, outletA)).toEqual([
        [2_000_000, 0],
      ]);
      expect(side(lines, ledger.surplus, outletA)).toEqual([[0, 2_000_000]]);
      expect(
        await auditCount("accounting.fixed_asset.revalued", revalued.id),
      ).toBe(1);
      const march = await run(entity, "2026-03");
      expect(march.amountIdr).toBe(1_200_000);
    },
  );

  it.skipIf(hasRevaluationRule)(
    "§3.19 revaluation fails closed with POSTING_RULE_MISSING while the contract has no revaluation rule",
    async () => {
      const entity = await createEntity("FA revaluation closed");
      await setupLedger(entity);
      const revalued = await asset(entity);
      await run(entity, "2026-01");
      await expect(
        revalueFixedAsset(
          tenantScope(),
          revalued.id,
          {
            revaluedOn: "2026-01-25",
            newCarryingAmountIdr: 13_000_000,
            reason: "Penilaian KJPP",
            idempotencyKey: key("reval"),
          },
          actor,
          NOW,
        ),
      ).rejects.toMatchObject({ code: "POSTING_RULE_MISSING" });
      const after = await getFixedAsset(tenantScope(), revalued.id);
      expect(after.asset.costIdr).toBe(12_000_000);
      expect(after.asset.accumulatedDepreciationIdr).toBe(1_000_000);
    },
  );

  it("§3.19 the scheduled job posts the month that ended once, as the system, and skips closed months", async () => {
    const entity = await createEntity("FA job");
    await setupLedger(entity);
    await asset(entity, {
      acquiredOn: "2026-06-01",
      depreciationStartPeriod: "2026-06",
    });
    const closed = await createEntity("FA job closed");
    await setupLedger(closed);
    await asset(closed, {
      acquiredOn: "2026-06-01",
      depreciationStartPeriod: "2026-06",
    });
    await closePeriod(closed, "2026-06");

    const julyFifth = new Date("2026-07-05T02:00:00Z");
    const first = await runDueDepreciation(tenantScope(), julyFifth);
    expect(first.period).toBe("2026-06");
    await runDueDepreciation(tenantScope(), julyFifth);

    const { rows } = await owner.query<{ posted_by: string | null }>(
      `SELECT posted_by FROM depreciation_runs
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-06'`,
      [tenantId, entity],
    );
    expect(rows).toEqual([{ posted_by: null }]);
    const { rows: keys } = await owner.query(
      "SELECT 1 FROM accounting_command_idempotency WHERE tenant_id = $1 AND key = $2",
      [tenantId, depreciationJobKey(entity, "2026-06")],
    );
    expect(keys).toHaveLength(1);
    const { rows: closedRuns } = await owner.query(
      "SELECT 1 FROM depreciation_runs WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, closed],
    );
    expect(closedRuns).toEqual([]);
  });
});

describe("legend-hpgo AP/AR open items and aging (§3.19 Utang & Piutang)", () => {
  it("§3.19 aging buckets current/1-30/31-60/61-90/>90 per supplier; as-of date replays the past", async () => {
    const entity = await createEntity("AP aging");
    const ledger = await setupLedger(entity);
    const context = tenantScope();
    const supplierA = randomUUID();
    const supplierB = randomUUID();
    const invoices: [string, string, string, number][] = [
      // [supplier, invoice date, due date, payable]
      [supplierA, "2026-10-28", "2026-11-10", 1_000_000], // current
      [supplierA, "2026-10-01", "2026-10-20", 2_000_000], // 16 days → 1-30
      [supplierA, "2026-08-25", "2026-09-20", 3_000_000], // 46 → 31-60
      [supplierB, "2026-07-20", "2026-08-20", 4_000_000], // 77 → 61-90
      [supplierB, "2026-06-01", "2026-07-01", 5_000_000], // 127 → >90
    ];
    const ids: string[] = [];
    for (const [supplierId, invoiceDate, dueOn, payableIdr] of invoices) {
      const id = randomUUID();
      ids.push(id);
      await withTenant(db, context, (tx) =>
        recordSupplierInvoicePayableInTransaction(
          tx,
          context,
          {
            supplierInvoiceId: id,
            legalEntityId: entity,
            outletId: outletA,
            supplierId,
            supplierName: supplierId === supplierA ? "CV Kopi" : "PT Susu",
            invoiceNumber: `INV-${unique()}`,
            invoiceDate,
            dueOn,
            payableIdr,
            journalEntryId: null,
            idempotencyKey: key("ap"),
          },
          actor,
        ),
      );
    }
    // Partial payment on 2026-11-02 of the 31-60 invoice.
    const paid = await withTenant(db, context, (tx) =>
      paySupplierInvoiceInTransaction(
        tx,
        context,
        {
          supplierInvoiceId: ids[2]!,
          supplierPaymentId: randomUUID(),
          amountIdr: 1_000_000,
          paidOn: "2026-11-02",
          idempotencyKey: key("pay"),
        },
        actor,
        NOW,
      ),
    );
    expect(paid.openItem.outstandingIdr).toBe(2_000_000);
    const payLines = await journalLinesOf(paid.journalEntryId!);
    expect(side(payLines, ledger.payable, outletA)).toEqual([[1_000_000, 0]]);
    expect(side(payLines, ledger.bank, outletA)).toEqual([[0, 1_000_000]]);

    const { client } = await financeUser();
    const response = await client.get(
      `/api/accounting/aging?legalEntityId=${entity}&kind=payable&asOf=2026-11-05`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = response.body.data;
    expect(report.bucketLabels).toEqual([
      "current",
      "1-30",
      "31-60",
      "61-90",
      ">90",
    ]);
    expect(report.bucketTotals).toEqual([
      1_000_000, 2_000_000, 2_000_000, 4_000_000, 5_000_000,
    ]);
    expect(report.totalIdr).toBe(14_000_000);
    expect(report.rows).toHaveLength(2);

    // Before the payment the invoice was still fully open.
    const past = await getAgingReportService(context, {
      legalEntityId: entity,
      kind: "payable",
      asOf: "2026-11-01",
    });
    expect(past.bucketTotals[2]).toBe(3_000_000);
  });

  it("§3.19 payment allocation: over-payment refused, concurrent payments serialize, replay and conflicting fingerprint", async () => {
    const entity = await createEntity("AP allocation");
    await setupLedger(entity);
    const context = tenantScope();
    const invoiceId = randomUUID();
    await withTenant(db, context, (tx) =>
      recordSupplierInvoicePayableInTransaction(
        tx,
        context,
        {
          supplierInvoiceId: invoiceId,
          legalEntityId: entity,
          outletId: null,
          supplierId: randomUUID(),
          supplierName: "PT Gula",
          invoiceNumber: "INV-ALLOC",
          invoiceDate: "2026-10-01",
          dueOn: "2026-10-31",
          payableIdr: 1_000_000,
          journalEntryId: null,
          idempotencyKey: key("ap"),
        },
        actor,
      ),
    );
    const pay = (amountIdr: number, idempotencyKey = key("pay")) =>
      withTenant(db, context, (tx) =>
        paySupplierInvoiceInTransaction(
          tx,
          context,
          {
            supplierInvoiceId: invoiceId,
            supplierPaymentId: randomUUID(),
            amountIdr,
            paidOn: "2026-10-15",
            idempotencyKey,
          },
          actor,
          NOW,
        ),
      );
    const results = await Promise.allSettled([pay(600_000), pay(600_000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });

    const replayKey = key("pay");
    const once = await pay(400_000, replayKey);
    // Same key, different payload (a new supplierPaymentId) → refused; the
    // exact-replay case is the next test.
    await expect(pay(400_000, replayKey)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(once.openItem.outstandingIdr).toBe(0);
    await expect(pay(1)).rejects.toMatchObject({ code: "CONFLICT" });
    const { rows } = await owner.query<{ settled_idr: string }>(
      "SELECT settled_idr FROM accounting_open_items WHERE tenant_id = $1 AND id = $2",
      [tenantId, invoiceId],
    );
    expect(Number(rows[0]?.settled_idr)).toBe(1_000_000);
    await expect(
      owner.query(
        "UPDATE accounting_open_items SET settled_idr = original_idr + 1 WHERE tenant_id = $1 AND id = $2",
        [tenantId, invoiceId],
      ),
    ).rejects.toThrow(/accounting_open_items_amounts_check/);
  });

  it("§3.19 an exact replay of a payment returns the first allocation without posting twice", async () => {
    const entity = await createEntity("AP replay");
    await setupLedger(entity);
    const context = tenantScope();
    const invoiceId = randomUUID();
    await withTenant(db, context, (tx) =>
      recordSupplierInvoicePayableInTransaction(
        tx,
        context,
        {
          supplierInvoiceId: invoiceId,
          legalEntityId: entity,
          outletId: outletA,
          supplierId: randomUUID(),
          supplierName: "PT Teh",
          invoiceNumber: "INV-REPLAY",
          invoiceDate: "2026-10-01",
          dueOn: "2026-10-31",
          payableIdr: 500_000,
          journalEntryId: null,
          idempotencyKey: key("ap"),
        },
        actor,
      ),
    );
    const request = {
      supplierInvoiceId: invoiceId,
      supplierPaymentId: randomUUID(),
      amountIdr: 200_000,
      paidOn: "2026-10-10",
      idempotencyKey: key("pay"),
    };
    const first = await withTenant(db, context, (tx) =>
      paySupplierInvoiceInTransaction(tx, context, request, actor, NOW),
    );
    const second = await withTenant(db, context, (tx) =>
      paySupplierInvoiceInTransaction(tx, context, request, actor, NOW),
    );
    expect(second).toEqual(first);
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'supplier_payment'`,
      [tenantId, entity],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("§3.19 receivables for corporate and event customers; write-off needs a reason, a same-entity journal, and is audited", async () => {
    const entity = await createEntity("AR");
    const ledger = await setupLedger(entity);
    const otherEntity = await createEntity("AR other");
    const otherLedger = await setupLedger(otherEntity);
    const context = tenantScope();
    const invoiceId = randomUUID();
    await withTenant(db, context, (tx) =>
      recordReceivableInTransaction(
        tx,
        context,
        {
          invoiceId,
          legalEntityId: entity,
          outletId: outletA,
          customerType: "corporate_account",
          customerId: randomUUID(),
          customerName: "PT Korporat",
          invoiceNumber: "AR-001",
          invoiceDate: "2026-09-01",
          dueOn: "2026-09-30",
          amountIdr: 3_000_000,
          journalEntryId: null,
          idempotencyKey: key("ar"),
        },
        actor,
      ),
    );
    const journal = (legalEntity: string, l: Ledger) =>
      withTenant(db, context, (tx) =>
        postJournalInTransaction(tx, context, {
          legalEntityId: legalEntity,
          outletId: outletA,
          entryDate: "2026-10-05",
          sourceType: "manual",
          sourceId: null,
          description: "Penghapusan piutang (test)",
          lines: [
            {
              accountId: accountIdSchema.parse(l.electricity),
              debitIdr: idr(500_000),
              creditIdr: idr(0),
              outletId: outletIdSchema.parse(outletA),
              costCenter: null,
            },
            {
              accountId: accountIdSchema.parse(l.receivable),
              debitIdr: idr(0),
              creditIdr: idr(500_000),
              outletId: outletIdSchema.parse(outletA),
              costCenter: null,
            },
          ],
          postedBy: actor,
          idempotencyKey: key("je"),
        }),
      );
    const foreignEntry = await journal(otherEntity, otherLedger);
    const settle = (journalEntryId: string, reason: string | null) =>
      withTenant(db, context, (tx) =>
        settleReceivableInTransaction(
          tx,
          context,
          {
            invoiceId,
            method: "write_off",
            receiptId: null,
            settledOn: "2026-10-05",
            amountIdr: 500_000,
            journalEntryId,
            reason,
            idempotencyKey: key("wo"),
          },
          actor,
        ),
      );
    await expect(settle(foreignEntry.id, null)).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(
      settle(foreignEntry.id, "Pelanggan pailit"),
    ).rejects.toMatchObject({ status: 422 });
    const entry = await journal(entity, ledger);
    const result = await settle(entry.id, "Pelanggan pailit");
    expect(result.openItem.outstandingIdr).toBe(2_500_000);
    expect(
      await auditCount("accounting.receivable.written_off", invoiceId),
    ).toBe(1);

    const aging = await getAgingReportService(context, {
      legalEntityId: entity,
      kind: "receivable",
      asOf: "2026-11-05",
    });
    expect(aging.totalIdr).toBe(2_500_000);
    expect(aging.bucketTotals[2]).toBe(2_500_000);
  });
});

describe("legend-hpgo budgets vs actual (§3.19 Anggaran)", () => {
  it("§3.19 budget per account and outlet with realisation; PUT upserts without duplicates", async () => {
    const entity = await createEntity("Budget");
    const ledger = await setupLedger(entity);
    const { client } = await financeUser();
    const put = (amount: number) =>
      client
        .put("/api/accounting/budgets")
        .set(originHeader)
        .send({
          legalEntityId: entity,
          rows: [
            {
              outletId: null,
              accountId: ledger.electricity,
              period: "2026-09",
              amountIdr: amount,
            },
            {
              outletId: outletA,
              accountId: ledger.electricity,
              period: "2026-09",
              amountIdr: 1_000_000,
            },
          ],
        });
    expect((await put(2_000_000)).status).toBe(200);
    const updated = await put(2_500_000);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toHaveLength(2);
    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*) FROM budgets WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity],
    );
    expect(Number(rows[0]?.count)).toBe(2);

    const context = tenantScope();
    const spend = (outlet: string, amount: number) =>
      withTenant(db, context, (tx) =>
        postJournalInTransaction(tx, context, {
          legalEntityId: entity,
          outletId: outlet,
          entryDate: "2026-09-15",
          sourceType: "manual",
          sourceId: null,
          description: "Tagihan listrik (test)",
          lines: [
            {
              accountId: accountIdSchema.parse(ledger.electricity),
              debitIdr: idr(amount),
              creditIdr: idr(0),
              outletId: outletIdSchema.parse(outlet),
              costCenter: null,
            },
            {
              accountId: accountIdSchema.parse(ledger.bank),
              debitIdr: idr(0),
              creditIdr: idr(amount),
              outletId: outletIdSchema.parse(outlet),
              costCenter: null,
            },
          ],
          postedBy: actor,
          idempotencyKey: key("je"),
        }),
      );
    await spend(outletA, 1_100_000);
    await spend(outletB, 900_000);

    const report = await client.get(
      `/api/accounting/budgets/vs-actual?legalEntityId=${entity}&period=2026-09`,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const byOutlet = new Map(
      report.body.data.map(
        (row: { outletId: string | null }) => [row.outletId, row] as const,
      ),
    );
    // Entity budget counts every outlet; the outlet budget only its own.
    expect(byOutlet.get(null)).toMatchObject({
      accountCode: "6201",
      budgetIdr: 2_500_000,
      actualIdr: 2_000_000,
      varianceIdr: -500_000,
      varianceBp: -2_000,
    });
    expect(byOutlet.get(outletA)).toMatchObject({
      budgetIdr: 1_000_000,
      actualIdr: 1_100_000,
      varianceIdr: 100_000,
      varianceBp: 1_000,
    });

    // TEN-03: outlet B sees neither the entity budget nor outlet A's.
    const outletView = await getBudgetVsActual(outletScope(outletB), {
      legalEntityId: entity,
      period: "2026-09",
    });
    expect(outletView.data).toEqual([]);
    const outletList = await listBudgets(outletScope(outletA), {
      legalEntityId: entity,
      period: "2026-09",
    });
    expect(outletList.data.map((row) => row.outletId)).toEqual([outletA]);

    const foreignAccount = await client
      .put("/api/accounting/budgets")
      .set(originHeader)
      .send({
        legalEntityId: entity,
        rows: [
          {
            outletId: null,
            accountId: randomUUID(),
            period: "2026-09",
            amountIdr: 1,
          },
        ],
      });
    expect(foreignAccount.status).toBe(422);
  });
});

describe("legend-hpgo tenant and outlet isolation", () => {
  it("TEN-03 requires authentication, a trusted origin and the accounting permissions", async () => {
    const entity = cafeLegendPlatformFixtures.legalEntity.id;
    const anonymous = agent(app);
    expect(
      (
        await anonymous.get(
          `/api/accounting/aging?legalEntityId=${entity}&kind=payable&asOf=2026-11-05`,
        )
      ).status,
    ).toBe(401);
    const { client } = await signedIn("No accounting role");
    expect(
      (
        await client.get(
          `/api/accounting/legal-entities/${entity}/fixed-assets`,
        )
      ).status,
    ).toBe(403);
    const forbidden = await client
      .post("/api/accounting/depreciation-runs")
      .set(originHeader)
      .send({
        legalEntityId: entity,
        period: "2026-01",
        idempotencyKey: key("run"),
      });
    expect(forbidden.status).toBe(403);
    const finance = await financeUser();
    const crossSite = await finance.client
      .post("/api/accounting/depreciation-runs")
      .set("Origin", "https://evil.example")
      .send({
        legalEntityId: entity,
        period: "2026-01",
        idempotencyKey: key("run"),
      });
    expect(crossSite.status).toBe(403);
    // Strict bodies: a smuggled tenantId is rejected (TEN-02).
    const smuggled = await finance.client
      .post("/api/accounting/depreciation-runs")
      .set(originHeader)
      .send({
        legalEntityId: entity,
        period: "2026-01",
        idempotencyKey: key("run"),
        tenantId: randomUUID(),
      });
    expect(smuggled.status).toBe(422);
  });

  it("TEN-03 cross-outlet: another outlet's asset and items are invisible; entity-level work needs tenant scope", async () => {
    const entity = await createEntity("Cross outlet");
    await setupLedger(entity);
    const own = await asset(entity, { outletId: outletA });
    const entityLevel = await asset(entity, { outletId: null });
    const outletBOnly = outletScope(outletB);
    await expect(getFixedAsset(outletBOnly, own.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      disposeFixedAsset(
        outletBOnly,
        own.id,
        {
          disposedOn: "2026-02-01",
          proceedsIdr: 0,
          reason: "Bukan outlet saya",
          idempotencyKey: key("disp"),
        },
        actor,
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await listFixedAssets(outletBOnly, entity)).data).toEqual([]);
    expect(
      (await listFixedAssets(outletScope(outletA), entity)).data.map(
        (item) => item.id,
      ),
    ).toEqual([own.id]);
    await expect(
      getFixedAsset(outletScope(outletA), entityLevel.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asset(entity, { outletId: outletA }, outletBOnly),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      asset(entity, { outletId: null }, outletBOnly),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      runDepreciation(
        outletScope(outletA),
        {
          legalEntityId: entity,
          period: "2026-01",
          idempotencyKey: key("run"),
        },
        actor,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      getAgingReportService(outletBOnly, {
        legalEntityId: entity,
        kind: "payable",
        asOf: "2026-11-05",
        outletId: outletA,
      }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("TEN-01 cross-tenant: foreign entities are not found and RLS hides every new table", async () => {
    const otherTenant = randomUUID();
    const otherEntity = randomUUID();
    const otherAsset = randomUUID();
    const otherAccount = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'AP/FA other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `apfa-${unique()}`, tenantId],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Other entity')",
      [otherEntity, otherTenant],
    );
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '6201', 'Beban Lain', 'expense', 'operating_expense')`,
      [otherAccount, otherTenant, otherEntity],
    );
    await owner.query(
      `INSERT INTO fixed_assets (id, tenant_id, legal_entity_id, code, name, acquired_on, cost_idr, useful_life_months, depreciation_start_period)
       VALUES ($1, $2, $3, 'FA-00001', 'Aset lain', '2026-01-01', 1000000, 12, '2026-01')`,
      [otherAsset, otherTenant, otherEntity],
    );
    await owner.query(
      `INSERT INTO budgets (tenant_id, legal_entity_id, account_id, period, amount_idr)
       VALUES ($1, $2, $3, '2026-09', 100)`,
      [otherTenant, otherEntity, otherAccount],
    );
    await owner.query(
      `INSERT INTO accounting_open_items (tenant_id, kind, id, legal_entity_id, counterparty_type, counterparty_id, counterparty_name, document_number, document_date, due_on, original_idr)
       VALUES ($1, 'payable', $2, $3, 'supplier', $2, 'Supplier lain', 'X-1', '2026-09-01', '2026-09-30', 100)`,
      [otherTenant, randomUUID(), otherEntity],
    );

    const { client } = await financeUser();
    expect(
      (
        await client.get(
          `/api/accounting/legal-entities/${otherEntity}/fixed-assets`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await client.get(`/api/accounting/fixed-assets/${otherAsset}`)).status,
    ).toBe(404);
    expect(
      (
        await client.get(
          `/api/accounting/aging?legalEntityId=${otherEntity}&kind=payable&asOf=2026-11-05`,
        )
      ).status,
    ).toBe(404);

    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      await appPool.query("BEGIN");
      await appPool.query("SET LOCAL ROLE legend_app");
      await appPool.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      for (const table of [
        "fixed_assets",
        "budgets",
        "accounting_open_items",
      ]) {
        const { rows } = await appPool.query(
          `SELECT 1 FROM ${table} WHERE tenant_id = $1`,
          [otherTenant],
        );
        expect(rows, table).toEqual([]);
      }
      await expect(
        appPool.query(
          `INSERT INTO budgets (tenant_id, legal_entity_id, account_id, period, amount_idr)
           VALUES ($1, $2, $3, '2026-10', 1)`,
          [otherTenant, otherEntity, otherAccount],
        ),
      ).rejects.toThrow(/row-level security/);
      await appPool.query("ROLLBACK");
    } finally {
      await appPool.end();
    }
  });

  it("forged contexts are refused at the service boundaries (TEN-02)", async () => {
    const forged = Object.freeze({
      tenant: { tenantId, brandId: null, source: "session" },
      outletScope: { kind: "tenant", tenantId },
    }) as unknown as ScopedTenantContext;
    await expect(
      runDepreciation(
        forged,
        {
          legalEntityId: cafeLegendPlatformFixtures.legalEntity.id,
          period: "2026-01",
          idempotencyKey: key("run"),
        },
        actor,
        NOW,
      ),
    ).rejects.toThrow(/Untrusted tenant context/);
    await expect(
      listBudgets(forged, {
        legalEntityId: cafeLegendPlatformFixtures.legalEntity.id,
        period: "2026-01",
      }),
    ).rejects.toThrow(/Untrusted tenant context/);
  });
});
