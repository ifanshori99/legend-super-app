// Fixed asset book value and disposal result (bead legend-v0s2): every reader
// (create, get, list, revalue, run, dispose) carries `bookValueIdr` (cost −
// accumulated) and `disposalResultIdr` (null until disposed; proceeds − book
// value), and the disposal result equals what the disposal journal booked to
// the disposal-result account. Runs the real PostgreSQL test DB; every test
// owns a fresh legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  POSTING_ACCOUNT_ROLES,
  fixedAssetSchema,
} from "@starter/shared/accounting";
import {
  createFixedAsset,
  disposeFixedAsset,
  getFixedAsset,
  listFixedAssets,
  revalueFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");
const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
/** Fixed "now" for service calls: every test date below is in the past. */
const NOW = new Date("2026-11-03T03:00:00Z");
const actor: UserId = userIdSchema.parse(randomUUID());

function tenantScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

/** Chart + posting-role mappings that depreciation, revaluation and disposal post through. */
async function setupLedger(
  entity: string,
): Promise<{ disposalResult: string }> {
  const rows: [string, string, string, string, string][] = [
    ["bank", "1103", "Bank Operasional", "asset", "cash_and_equivalents"],
    ["fixed_assets", "1501", "Aset Tetap", "asset", "non_current_asset"],
    [
      "accumulated_depreciation",
      "1502",
      "Akumulasi Penyusutan",
      "asset",
      "non_current_asset",
    ],
    ["revaluation_surplus", "3201", "Surplus Revaluasi", "equity", "equity"],
    [
      "asset_disposal_result",
      "7101",
      "Laba/Rugi Pelepasan Aset",
      "revenue",
      "other_income",
    ],
    [
      "depreciation_expense",
      "6101",
      "Beban Penyusutan",
      "expense",
      "operating_expense",
    ],
    [
      "asset_revaluation_loss",
      "6102",
      "Rugi Revaluasi",
      "expense",
      "other_expense",
    ],
  ];
  let disposalResult = "";
  for (const [role, code, label, type, group] of rows) {
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, label, type, group],
    );
    if (role === "asset_disposal_result") disposalResult = inserted[0]!.id;
    if (!(role in POSTING_ACCOUNT_ROLES)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, inserted[0]!.id],
    );
  }
  return { disposalResult };
}

const asset = (
  entity: string,
  input: Partial<{
    costIdr: number;
    residualValueIdr: number;
    usefulLifeMonths: number;
  }> = {},
) =>
  createFixedAsset(
    tenantScope(),
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

const run = (entity: string, period: string) =>
  runDepreciation(
    tenantScope(),
    { legalEntityId: entity, period, idempotencyKey: key("run") },
    actor,
    NOW,
  );

const dispose = (
  fixedAssetId: string,
  disposedOn: string,
  proceedsIdr: number,
) =>
  disposeFixedAsset(
    tenantScope(),
    fixedAssetId,
    {
      disposedOn,
      proceedsIdr,
      reason: "Pelepasan aset",
      idempotencyKey: key("disp"),
    },
    actor,
    NOW,
  );

/** Net credit (+) / debit (−) the disposal journal booked to the result account. */
async function journalDisposalResult(
  assetId: string,
  resultAccount: string,
): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    `SELECT COALESCE(SUM(l.credit_idr - l.debit_idr), 0) AS net
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
      WHERE e.tenant_id = $1 AND e.source_type = 'asset_disposal'
        AND e.source_id = $2 AND l.account_id = $3`,
    [tenantId, assetId, resultAccount],
  );
  return Number(rows[0]!.net);
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("legend-v0s2 asset book value", () => {
  it("an active asset: book value = cost − accumulated, no disposal result, on create/get/list", async () => {
    const entity = await createEntity("Book value active");
    await setupLedger(entity);
    const created = await asset(entity);
    expect(created.bookValueIdr).toBe(12_000_000);
    expect(created.disposalResultIdr).toBeNull();

    await run(entity, "2026-01");
    await run(entity, "2026-02");
    const { asset: fetched } = await getFixedAsset(tenantScope(), created.id);
    expect(fetched.accumulatedDepreciationIdr).toBe(2_000_000);
    expect(fetched.bookValueIdr).toBe(10_000_000);
    expect(fetched.disposalResultIdr).toBeNull();

    const { data } = await listFixedAssets(tenantScope(), entity);
    const listed = data.find((row) => row.id === created.id)!;
    expect(listed.bookValueIdr).toBe(10_000_000);
    expect(listed.disposalResultIdr).toBeNull();
    expect(fixedAssetSchema.safeParse(listed).success).toBe(true);
  });

  it("a fully depreciated asset keeps its residual value as book value", async () => {
    const entity = await createEntity("Book value full");
    await setupLedger(entity);
    const created = await asset(entity, {
      costIdr: 2_000_000,
      residualValueIdr: 500_000,
      usefulLifeMonths: 2,
    });
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    const { asset: fetched } = await getFixedAsset(tenantScope(), created.id);
    expect(fetched.status).toBe("fully_depreciated");
    expect(fetched.accumulatedDepreciationIdr).toBe(1_500_000);
    expect(fetched.bookValueIdr).toBe(500_000);
    expect(fetched.disposalResultIdr).toBeNull();
  });

  it("a revaluation above cost restates cost; book value is the new carrying amount", async () => {
    const entity = await createEntity("Book value reval");
    await setupLedger(entity);
    const created = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    const revalued = await revalueFixedAsset(
      tenantScope(),
      created.id,
      {
        revaluedOn: "2026-02-25",
        newCarryingAmountIdr: 13_000_000,
        reason: "Penilaian KJPP",
        idempotencyKey: key("reval"),
      },
      actor,
      NOW,
    );
    expect(revalued.costIdr).toBeGreaterThan(12_000_000);
    expect(revalued.bookValueIdr).toBe(13_000_000);
    expect(revalued.bookValueIdr).toBe(
      revalued.costIdr - revalued.accumulatedDepreciationIdr,
    );
    expect(revalued.disposalResultIdr).toBeNull();
    const { asset: fetched } = await getFixedAsset(tenantScope(), created.id);
    expect(fetched.bookValueIdr).toBe(13_000_000);
  });

  it("disposal at a gain: result = proceeds − book value, equals the journal and the response on every reader", async () => {
    const entity = await createEntity("Book value gain");
    const ledger = await setupLedger(entity);
    const created = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    // Catch-up through March: accumulated 3,000,000, book value 9,000,000.
    const disposed = await dispose(created.id, "2026-03-15", 9_500_000);
    expect(disposed.status).toBe("disposed");
    expect(disposed.accumulatedDepreciationIdr).toBe(3_000_000);
    expect(disposed.bookValueIdr).toBe(9_000_000);
    expect(disposed.disposalResultIdr).toBe(500_000);
    expect(await journalDisposalResult(created.id, ledger.disposalResult)).toBe(
      500_000,
    );

    const { asset: fetched } = await getFixedAsset(tenantScope(), created.id);
    expect(fetched.bookValueIdr).toBe(9_000_000);
    expect(fetched.disposalResultIdr).toBe(500_000);
    const { data } = await listFixedAssets(tenantScope(), entity);
    expect(data.find((row) => row.id === created.id)!.disposalResultIdr).toBe(
      500_000,
    );
  });

  it("disposal at a loss: negative result equals the journal debit", async () => {
    const entity = await createEntity("Book value loss");
    const ledger = await setupLedger(entity);
    const created = await asset(entity, { costIdr: 2_400_000 });
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    // Scrapped in February (caught up): accumulated 400,000, book value 2,000,000.
    const disposed = await dispose(created.id, "2026-02-20", 0);
    expect(disposed.bookValueIdr).toBe(2_000_000);
    expect(disposed.disposalResultIdr).toBe(-2_000_000);
    expect(await journalDisposalResult(created.id, ledger.disposalResult)).toBe(
      -2_000_000,
    );
  });

  it("the contract refuses an inconsistent book value or disposal result", async () => {
    const entity = await createEntity("Book value contract");
    await setupLedger(entity);
    const active = await asset(entity);
    const tampered = (patch: Record<string, unknown>) =>
      fixedAssetSchema.safeParse({ ...active, ...patch }).success;
    expect(tampered({})).toBe(true);
    expect(tampered({ bookValueIdr: 1 })).toBe(false);
    // A result without disposal, or a disposal with a wrong result, is refused.
    expect(tampered({ disposalResultIdr: 0 })).toBe(false);
    const disposed = await dispose(active.id, "2026-01-20", 1_000_000);
    expect(fixedAssetSchema.safeParse(disposed).success).toBe(true);
    expect(
      fixedAssetSchema.safeParse({
        ...disposed,
        disposalResultIdr: disposed.disposalResultIdr! + 1,
      }).success,
    ).toBe(false);
    expect(
      fixedAssetSchema.safeParse({ ...disposed, disposalResultIdr: null })
        .success,
    ).toBe(false);
  });
});
