// Shared fixtures for the ledger-guard DB tests (findings 1, 2, 5, 6 of
// docs/briefs/497-findings-fixes.md; cards legend-lt0v4, legend-k048r). Not a
// test file. Everything here writes plain SQL as the migration owner, or as the
// application role (`legend_app`), so the tests prove the database holds on
// every path. The only service calls are the fixed-asset ones, used to build a
// realistic depreciation ledger.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
import { POSTING_ACCOUNT_ROLES } from "@starter/shared/accounting";
import {
  createFixedAsset,
  disposeFixedAsset,
  revalueFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";

export const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
export const unique = () => randomBytes(4).toString("hex");
export const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
/** Fixed "now" for service calls: every test date is in the past. */
export const NOW = new Date("2026-11-03T03:00:00Z");

export const closer = randomUUID();
export const reopener = randomUUID();
/** Approves a reopen: must differ from the closer (APPROVER_IS_CLOSER). */
export const approver = randomUUID();
export const actor: UserId = userIdSchema.parse(randomUUID());
let usersReady: Promise<void> | undefined;

export function ensureUsers(): Promise<void> {
  usersReady ??= (async () => {
    for (const id of [closer, reopener])
      await owner.query(
        'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
        [id, "Ledger guard test", `${id}@example.com`],
      );
  })();
  return usersReady;
}

export function tenantScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/** Runs `fn` in one transaction as the application database role. */
export async function withAppRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` in one transaction as the migration owner. */
export async function withOwner<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---- Period fixtures ----------------------------------------------------------

export type Fx = {
  entity: string;
  cash: string;
  revenue: string;
  jan: string; // fiscal period ids
  feb: string;
};

export async function makeEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

/** A fresh legal entity with two accounts and open periods 2025-01 and 2025-02. */
export async function makeFixture(): Promise<Fx> {
  await ensureUsers();
  const entity = await makeEntity("Ledger guard");
  const cash = randomUUID();
  const revenue = randomUUID();
  const jan = randomUUID();
  const feb = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [cash, revenue, tenantId, entity],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
     VALUES ($1, $3, $4, '2025-01'), ($2, $3, $4, '2025-02')`,
    [jan, feb, tenantId, entity],
  );
  return { entity, cash, revenue, jan, feb };
}

export type RawLine = {
  accountId: string;
  debit: number;
  credit: number;
  outletId?: string | null;
};

export type RawEntry = {
  entity: string;
  periodId: string;
  date: string;
  sourceType?: string;
  reversalOf?: string | null;
  /** null = insert the entry only (no lines). */
  lines: RawLine[] | null;
};

/** Inserts one journal entry (and its lines) on an open client; returns its id. */
export async function rawInsertEntry(
  client: PoolClient,
  input: RawEntry,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Ledger guard raw insert', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      input.entity,
      input.date,
      input.periodId,
      input.sourceType ?? "sale",
      input.reversalOf ?? null,
      `raw-${randomUUID()}`,
      randomBytes(32).toString("hex"),
    ],
  );
  const entryId = rows[0]!.id;
  let lineNo = 1;
  for (const line of input.lines ?? []) {
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        entryId,
        line.accountId,
        lineNo,
        line.debit,
        line.credit,
        line.outletId ?? null,
      ],
    );
    lineNo += 1;
  }
  return entryId;
}

/** Balanced cash/revenue lines for a raw entry of the period fixture. */
export const saleLines = (fx: Fx, amount: number): RawLine[] => [
  { accountId: fx.cash, debit: amount, credit: 0 },
  { accountId: fx.revenue, debit: 0, credit: amount },
];

export async function entryCount(
  entity: string,
  periodId: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE legal_entity_id = $1 AND fiscal_period_id = $2",
    [entity, periodId],
  );
  return Number(rows[0]!.n);
}

export type PeriodRow = {
  status: string;
  version: number;
  period: string;
  legal_entity_id: string;
  closed_by: string | null;
  reopened_by: string | null;
};

export async function periodRow(periodId: string): Promise<PeriodRow> {
  const { rows } = await owner.query<PeriodRow>(
    `SELECT status, version, period, legal_entity_id, closed_by, reopened_by
       FROM fiscal_periods WHERE id = $1`,
    [periodId],
  );
  return rows[0]!;
}

/** The legal-entity ledger version (bigint comes back as text). */
export async function ledgerVersion(entity: string): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    "SELECT ledger_version::text AS v FROM legal_entities WHERE tenant_id = $1 AND id = $2",
    [tenantId, entity],
  );
  return Number(rows[0]!.v);
}

/** SQL of a legal close: status flip with the version raised by exactly one. */
export const CLOSE_SQL = `UPDATE fiscal_periods
   SET status = 'closed', closed_by = $2, closed_at = now(), version = version + 1
 WHERE id = $1`;

/** SQL of a legal reopen: status flip back, reopen audit set, version + 1. */
export const REOPEN_SQL = `UPDATE fiscal_periods
   SET status = 'open', closed_by = NULL, closed_at = NULL,
       reopened_by = $2, reopened_at = now(), reopened_reason = 'Koreksi (ledger guard test)',
       version = version + 1
 WHERE id = $1`;

// ---- Fixed-asset ledger (through the services) ------------------------------

export async function setupAssetLedger(entity: string): Promise<void> {
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
  for (const [role, code, label, type, group] of rows) {
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, label, type, group],
    );
    if (!(role in POSTING_ACCOUNT_ROLES)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, inserted[0]!.id],
    );
  }
}

/** 12,000,000 over 12 months = 1,000,000 per month, starting 2026-01. */
export const createAsset = (entity: string) =>
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
    },
    actor,
    NOW,
  );

export const runMonth = (entity: string, period: string) =>
  runDepreciation(
    tenantScope(),
    { legalEntityId: entity, period, idempotencyKey: key("run") },
    actor,
    NOW,
  );

export const disposeAsset = (
  assetId: string,
  disposedOn: string,
  proceedsIdr: number,
) =>
  disposeFixedAsset(
    tenantScope(),
    assetId,
    {
      disposedOn,
      proceedsIdr,
      reason: "Dijual mundur",
      idempotencyKey: key("disp"),
    },
    actor,
    NOW,
  );

export const revalueAsset = (
  assetId: string,
  revaluedOn: string,
  newCarryingAmountIdr: number,
) =>
  revalueFixedAsset(
    tenantScope(),
    assetId,
    {
      revaluedOn,
      newCarryingAmountIdr,
      reason: "Penilaian mundur",
      idempotencyKey: key("reval"),
    },
    actor,
    NOW,
  );

export type DepreciationRow = {
  id: string;
  period: string;
  amount: number;
  journalEntryId: string;
  generation: number;
};

/** Every depreciation row of the asset (all generations), oldest first. */
export async function allDepreciationRows(
  assetId: string,
): Promise<DepreciationRow[]> {
  const { rows } = await owner.query<{
    id: string;
    period: string;
    amount_idr: string;
    journal_entry_id: string;
    generation: number;
  }>(
    `SELECT id, period, amount_idr, journal_entry_id, generation
       FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND fixed_asset_id = $2
      ORDER BY period, generation`,
    [tenantId, assetId],
  );
  return rows.map((row) => ({
    id: row.id,
    period: row.period,
    amount: Number(row.amount_idr),
    journalEntryId: row.journal_entry_id,
    generation: row.generation,
  }));
}

type JournalShape = {
  entity: string;
  periodId: string;
  date: string;
  sourceType: string;
  lines: RawLine[];
};

async function readJournal(entryId: string): Promise<JournalShape> {
  const { rows: entry } = await owner.query<{
    legal_entity_id: string;
    fiscal_period_id: string;
    entry_date: string;
    source_type: string;
  }>(
    `SELECT legal_entity_id, fiscal_period_id, entry_date::text AS entry_date, source_type
       FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, entryId],
  );
  const { rows: lines } = await owner.query<{
    account_id: string;
    debit_idr: string;
    credit_idr: string;
    outlet_id: string | null;
  }>(
    `SELECT account_id, debit_idr, credit_idr, outlet_id
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no`,
    [tenantId, entryId],
  );
  return {
    entity: entry[0]!.legal_entity_id,
    periodId: entry[0]!.fiscal_period_id,
    date: entry[0]!.entry_date,
    sourceType: entry[0]!.source_type,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      debit: Number(line.debit_idr),
      credit: Number(line.credit_idr),
      outletId: line.outlet_id,
    })),
  };
}

/**
 * Writes a correcting journal for `originalId` as the migration owner.
 * Default: same entity, same period and date, every line mirrored (debit and
 * credit swapped), and no `reversal_of` (a correction is not a manual reversal).
 * Options bend one property at a time so a test can prove the function rejects it.
 */
export async function postCorrection(
  originalId: string,
  options: {
    /** false = same direction as the original (not a correction at all). */
    mirror?: boolean;
    /** Replaces the debit/credit amount on every line. */
    amount?: number;
    /** Post into another journal's period and date instead. */
    likeJournalId?: string;
  } = {},
): Promise<string> {
  const original = await readJournal(originalId);
  const placeLike = options.likeJournalId
    ? await readJournal(options.likeJournalId)
    : original;
  const mirror = options.mirror ?? true;
  const lines = original.lines.map((line) => {
    const debit = mirror ? line.credit : line.debit;
    const credit = mirror ? line.debit : line.credit;
    const set = (value: number) =>
      options.amount !== undefined && value > 0 ? options.amount : value;
    return { ...line, debit: set(debit), credit: set(credit) };
  });
  return withOwner((client) =>
    rawInsertEntry(client, {
      entity: original.entity,
      periodId: placeLike.periodId,
      date: placeLike.date,
      sourceType: original.sourceType,
      reversalOf: null,
      lines,
    }),
  );
}

export type DbError = Error & { code?: string };

/** Awaits a promise that must reject and returns the database error. */
export async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    return error as DbError;
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}
