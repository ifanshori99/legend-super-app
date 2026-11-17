// Re-seal of `sealSecret` columns that have no key version column (bead
// legend-tetyr): MFA secrets, identity values, NPWP, bank accounts, table, bill
// split, order, reservation, voucher and receipt tokens. rotate-data-key covers
// integrations and AI keys (they carry a version column), HRIS and payroll have
// their own job (hris-pii-reseal.job.ts); this job covers the rest, so an old
// data key version can retire once `remaining` (minus `frozen`) is 0.
//
// Stale = the envelope's version byte (lib/secrets.ts) is below the active
// version. The SQL filter reads that byte from the column itself, so no
// per-column version column is needed. Each row is opened under its own
// version and sealed under the active one with the SAME AAD the writer uses,
// then written back only if the value is still the one that was read
// (compare-and-set). `bank_accounts.account_number_key_version` is NOT the
// envelope version: it is a label inside that column's AAD, so it stays as is.
//
// Resumable: work is cut into batches of 200 ordered by id, each batch one
// transaction that selects `FOR UPDATE SKIP LOCKED`. The id cursor of the pass
// in flight lives in `sealed_secret_reseal_state` (one row per table, column
// and scope), written in the same transaction as the batch, so a killed run
// resumes after the last committed batch. A finished pass resets the cursor,
// so the next run starts at the top and retries rows that failed or were
// locked. A row that will not open or write is counted failed (its own
// savepoint) and does not stop the column. Nothing is logged but counts, table
// and column names and tenant ids: never a sealed or opened value.
//
// Some rows are frozen by the database (POS-04 triggers refuse any change to a
// completed or voided order and to its tenders; the app login has no UPDATE on
// apology_vouchers at all). They are never attempted; they
// stay in `remaining` and are also counted in `frozen`, so they cannot pass as
// done.

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { uuidToUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  currentSealVersion,
  openSecret,
  sealSecret,
  sealedVersion,
} from "../lib/secrets.ts";
import { listAllTenantIds } from "./hris-pii-reseal.job.ts";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Log = Pick<Console, "error" | "info">;

export const SEALED_SECRET_RESEAL_QUEUE = "sealed-secret-reseal";
export const SEALED_SECRET_RESEAL_BATCH = 200;
/** Weekly, Sunday 03:30 Asia/Jakarta (after the 03:15 data key rotation). */
export const SEALED_SECRET_RESEAL_CRON = "30 3 * * 0";
export const SEALED_SECRET_RESEAL_TZ = "Asia/Jakarta";
const SEALED_SECRET_RESEAL_EXPIRE_SECONDS = 2 * 60 * 60;
const GLOBAL_SCOPE = "global";

/** What a registry AAD builder sees of one row. */
type SealedRow = {
  /** Row id as the writer knows it (ULID for ulid-in-uuid ids). */
  id: string;
  /** Tenant id; "" for global tables. */
  tenantId: string;
  /** Extra columns named in `extra`, as text, in that order. */
  extra: string[];
};

export type SealedSecretColumn = {
  /** SQL table and column names (static identifiers). */
  table: string;
  column: string;
  /** `tenant`: filtered by tenant_id under RLS; `global`: no tenant. */
  scope: "tenant" | "global";
  /** `text` holds the base64 envelope; `bytea` holds its decoded bytes. */
  encoding: "text" | "bytea";
  /** The id column is a ULID stored as uuid; the AAD uses the ULID text. */
  idIsUlid?: boolean;
  /** Extra columns the AAD needs (selected as text). */
  extra?: readonly string[];
  /** Static SQL on alias `t`: only these rows are in scope. */
  where?: string;
  /** Static SQL on alias `t`: rows the database refuses to change. */
  frozenWhere?: string;
  /** AADs the writers use; the first one that opens the value is reused. */
  aad(row: SealedRow): string[];
};

const ORDER_FINAL = "t.status IN ('completed', 'voided')";

/**
 * Every sealed column this job moves. Each AAD is copied from the writer named
 * in the comment. Left out on purpose (not here): HRIS and payroll sealed
 * values (piiKeyVersion, hris-pii-reseal.job.ts), integration credentials and
 * AI provider keys (rotate-data-key), push subscriptions and the ChatGPT
 * connection tokens (own key columns / services).
 */
export const SEALED_SECRET_COLUMNS: readonly SealedSecretColumn[] = [
  {
    // identity-mfa.service.ts aad()
    table: "mfa_factors",
    column: "secret_encrypted",
    scope: "global",
    encoding: "text",
    extra: ["user_id"],
    aad: (r) => [`mfa-factor:${r.id}:${(r.extra[0] ?? "").toLowerCase()}`],
  },
  {
    // auth.ts, identity-account, identity-wa-inbound, identity-email-login,
    // platform-admin-provision: `user_identity:<type>:<value_hash>`
    table: "user_identities",
    column: "value_encrypted",
    scope: "global",
    encoding: "text",
    extra: ["type", "value_hash"],
    where: "t.type IN ('whatsapp', 'email')",
    aad: (r) => [`user_identity:${r.extra[0]}:${r.extra[1]}`],
  },
  {
    // identity-email-login / identity-invitation challengeEmailAad()
    table: "login_challenges",
    column: "email_encrypted",
    scope: "global",
    encoding: "text",
    aad: (r) => [`login_challenge:email:${r.id}`],
  },
  {
    // org.service.ts npwpColumns()
    table: "legal_entities",
    column: "npwp_encrypted",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`legal_entity:${r.tenantId}`],
  },
  {
    // profit-share-registry.service.ts sealedNpwp()
    table: "shareholders",
    column: "npwp_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`shareholder:${r.tenantId}:${r.id}:npwp`],
  },
  {
    // profit-share-registry.service.ts sealedPayout()
    table: "shareholders",
    column: "payout_account_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`shareholder:${r.tenantId}:${r.id}:payout_account`],
  },
  {
    // accounting-bank-accounts.service.ts; the `k<n>` in the AAD is the
    // column's own account_number_key_version, which stays unchanged.
    table: "bank_accounts",
    column: "account_number_encrypted",
    scope: "tenant",
    encoding: "bytea",
    extra: ["account_number_key_version"],
    aad: (r) => [
      `bank:bank_accounts:${r.tenantId.toLowerCase()}:${r.id.toLowerCase()}:account_number:k${r.extra[0]}`,
    ],
  },
  {
    // floor.service.ts qrSealAad()
    table: "tables",
    column: "qr_token_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`table-qr:${r.tenantId}:${r.id}`],
  },
  {
    // table-session.service.ts sessionSealAad()
    table: "table_sessions",
    column: "session_token_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`table-session:${r.tenantId}:${r.id}`],
  },
  {
    // bill-split.service.ts claimAad()
    table: "bill_splits",
    column: "claim_token_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`bill-split-claim:${r.tenantId}:${r.id}`],
  },
  {
    // qr-order-payment.ts linkSealAad() and facility-breakfast.service.ts
    // linkSealAad(): both write this column, so both AADs are tried.
    table: "orders",
    column: "payment_link_token_sealed",
    scope: "tenant",
    encoding: "text",
    idIsUlid: true,
    frozenWhere: ORDER_FINAL,
    aad: (r) => [
      `qr-order-payment-link:${r.tenantId}:${r.id}`,
      `facility-breakfast-payment-link:${r.tenantId}:${r.id}`,
    ],
  },
  {
    // table-claim.service.ts orderClaimAad()
    table: "orders",
    column: "claim_token_sealed",
    scope: "tenant",
    encoding: "text",
    idIsUlid: true,
    frozenWhere: ORDER_FINAL,
    aad: (r) => [`order-claim:${r.tenantId}:${r.id}`],
  },
  {
    // reservation-booking.ts linkAad(), shared with reservation-deposit-resend.ts
    table: "reservations",
    column: "deposit_link_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`reservation-deposit:${r.tenantId}:${r.id}`],
  },
  {
    // apology-voucher.service.ts sealAad(tenant, voucher id). Frozen: migration
    // 0212 revokes UPDATE on this table from the app login (append-only, the
    // voucher is money-adjacent), so the job cannot and must not rewrite it.
    // It stays in `remaining` until an owner-approved path exists.
    table: "apology_vouchers",
    column: "code_sealed",
    scope: "tenant",
    encoding: "text",
    extra: ["voucher_id"],
    frozenWhere: "true",
    aad: (r) => [`apology-voucher:${r.tenantId}:${r.extra[0]}`],
  },
  {
    // pos-receipt-delivery.service.ts, bound to the receipt id
    table: "pos_receipt_deliveries",
    column: "destination_sealed",
    scope: "tenant",
    encoding: "text",
    extra: ["receipt_id"],
    aad: (r) => [`pos_receipt_delivery:${r.tenantId}:${r.extra[0]}`],
  },
  {
    // pos-order-payment.ts linkSealAad(tenant, tender id)
    table: "pos_order_tenders",
    column: "payment_link_token_sealed",
    scope: "tenant",
    encoding: "text",
    frozenWhere:
      "EXISTS (SELECT 1 FROM public.orders o WHERE o.tenant_id = t.tenant_id AND o.id = t.order_id AND o.status IN ('completed', 'voided'))",
    aad: (r) => [`pos-order-payment-link:${r.tenantId}:${r.id}`],
  },
  {
    // qr-order-payment.ts chargeLinkSealAad(), order-recovery-charge-payment.ts
    table: "order_issue_charges",
    column: "payment_link_token_sealed",
    scope: "tenant",
    encoding: "text",
    aad: (r) => [`order-issue-charge-link:${r.tenantId}:${r.id}`],
  },
];

export type SealedSecretColumnReport = {
  resealed: number;
  failed: number;
  /** Rows still below the active version after the run (frozen included). */
  remaining: number;
  /** Part of `remaining` that the database refuses to change. */
  frozen: number;
};

export type SealedSecretResealResult = {
  activeVersion: number;
  /** Keyed by `<table>.<column>`, summed over all scopes. */
  tables: Record<string, SealedSecretColumnReport>;
  /** Tenants whose pass threw (database error); the others still ran. */
  failedTenants: number;
  /** True when the abort signal stopped the run before it was done. */
  aborted: boolean;
};

export type SealedSecretResealOptions = {
  database?: Database;
  log?: Pick<Console, "error">;
  batchSize?: number;
  /** Version to move rows to; defaults to the ring's active version. */
  activeKeyVersion?: number;
  /** Count only: no row is changed and no state is written. */
  reportOnly?: boolean;
  /** Stops the run cleanly between batches. */
  signal?: AbortSignal;
  /** Called after each committed batch (test hook). */
  afterBatch?: (batch: {
    table: string;
    column: string;
    scope: string;
    count: number;
  }) => void | Promise<void>;
  /** Test hook; defaults to every tenant, whatever its status. */
  listTenantIds?: () => Promise<string[]>;
  /** Test hook; defaults to the whole registry. */
  columns?: readonly SealedSecretColumn[];
};

const keyOf = (c: SealedSecretColumn) => `${c.table}.${c.column}`;

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/** `public."<table>"` from the static registry. */
const tableSql = (c: SealedSecretColumn): SQL =>
  sql`${sql.identifier("public")}.${sql.identifier(c.table)}`;

/** Version byte of the stored envelope is below `active`. */
function staleSql(c: SealedSecretColumn, active: number): SQL {
  const col = sql.identifier(c.column);
  return c.encoding === "bytea"
    ? sql`(length(t.${col}) > 0 AND get_byte(t.${col}, 0) < ${active})`
    : sql`(CASE WHEN t.${col} ~ '^[A-Za-z0-9+/]{4}' THEN get_byte(decode(substring(t.${col} from 1 for 4), 'base64'), 0) END < ${active})`;
}

/** Tenant, scope and `where` filters shared by every query on a column. */
function scopeSql(c: SealedSecretColumn, scope: string): SQL {
  const parts: SQL[] = [sql`true`];
  if (c.scope === "tenant") parts.push(sql`t.tenant_id = ${scope}::uuid`);
  if (c.where) parts.push(sql.raw(`(${c.where})`));
  return sql.join(parts, sql` AND `);
}

type ResultRows = { rows: Record<string, unknown>[]; rowCount: number | null };

async function countRows(
  tx: Transaction,
  c: SealedSecretColumn,
  scope: string,
  active: number,
  frozenOnly: boolean,
): Promise<number> {
  const frozen =
    frozenOnly && c.frozenWhere
      ? sql.raw(` AND (${c.frozenWhere})`)
      : frozenOnly
        ? sql` AND false`
        : sql``;
  const result = (await tx.execute(
    sql`SELECT count(*)::int AS n FROM ${tableSql(c)} t WHERE ${scopeSql(c, scope)} AND ${staleSql(c, active)}${frozen}`,
  )) as unknown as ResultRows;
  return Number(result.rows[0]?.n ?? 0);
}

type PassState = { lastId: string | null; failed: number };

async function loadState(
  tx: Transaction,
  c: SealedSecretColumn,
  scope: string,
  active: number,
): Promise<PassState> {
  const result = (await tx.execute(
    sql`SELECT last_id::text AS last_id, key_version, failed_count FROM sealed_secret_reseal_state WHERE table_name = ${c.table} AND column_name = ${c.column} AND scope_key = ${scope}`,
  )) as unknown as ResultRows;
  const row = result.rows[0];
  // A cursor from another key version belongs to a finished pass.
  if (!row || row.last_id === null || Number(row.key_version) !== active)
    return { lastId: null, failed: 0 };
  return { lastId: String(row.last_id), failed: Number(row.failed_count) };
}

async function saveState(
  tx: Transaction,
  c: SealedSecretColumn,
  scope: string,
  active: number,
  state: PassState,
  resealedNow: number,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO sealed_secret_reseal_state
      (table_name, column_name, scope_key, last_id, key_version, resealed_count, failed_count, updated_at)
    VALUES (${c.table}, ${c.column}, ${scope}, ${state.lastId}::uuid, ${active}, ${resealedNow}, ${state.failed}, now())
    ON CONFLICT (table_name, column_name, scope_key) DO UPDATE SET
      last_id = EXCLUDED.last_id,
      key_version = EXCLUDED.key_version,
      resealed_count = sealed_secret_reseal_state.resealed_count + EXCLUDED.resealed_count,
      failed_count = EXCLUDED.failed_count,
      updated_at = now()
  `);
}

/** Opens under the first AAD that authenticates and seals under the active key. */
function resealValue(sealed: string, aads: string[]): string {
  let lastError: unknown;
  for (const aad of aads) {
    let plaintext: string;
    try {
      plaintext = openSecret(sealed, aad);
    } catch (error) {
      lastError = error;
      continue;
    }
    return sealSecret(plaintext, aad);
  }
  throw lastError instanceof Error ? lastError : new Error("Cannot open");
}

/**
 * One batch: lock stale rows after the cursor, re-seal each in its own
 * savepoint, move the cursor. Returns the rows handled (0 = pass finished).
 */
async function resealBatch(
  tx: Transaction,
  c: SealedSecretColumn,
  scope: string,
  active: number,
  batchSize: number,
  state: PassState,
): Promise<{ handled: number; resealed: number }> {
  const col = sql.identifier(c.column);
  const sealedExpr =
    c.encoding === "bytea"
      ? sql`replace(encode(t.${col}, 'base64'), E'\\n', '')`
      : sql`t.${col}`;
  const extras = (c.extra ?? []).map(
    (name, i) =>
      sql`, t.${sql.identifier(name)}::text AS ${sql.identifier(`x${i}`)}`,
  );
  const cursor =
    state.lastId === null ? sql`` : sql` AND t.id > ${state.lastId}::uuid`;
  const frozen = c.frozenWhere ? sql.raw(` AND NOT (${c.frozenWhere})`) : sql``;
  const result = (await tx.execute(
    sql`SELECT t.id::text AS id, ${sealedExpr} AS sealed${sql.join(extras, sql``)} FROM ${tableSql(c)} t WHERE ${scopeSql(c, scope)} AND ${staleSql(c, active)}${frozen}${cursor} ORDER BY t.id LIMIT ${batchSize} FOR UPDATE OF t SKIP LOCKED`,
  )) as unknown as ResultRows;

  let resealed = 0;
  for (const row of result.rows) {
    const uuid = String(row.id);
    const sealed = String(row.sealed);
    state.lastId = uuid;
    try {
      // The SQL filter already narrowed to stale rows; check the byte again so
      // a row never moves down or sideways.
      if (sealedVersion(sealed) >= active) continue;
      const sealedRow: SealedRow = {
        id: c.idIsUlid ? uuidToUlid(uuid) : uuid,
        tenantId: c.scope === "tenant" ? scope : "",
        extra: (c.extra ?? []).map((_, i) => String(row[`x${i}`])),
      };
      const next = resealValue(sealed, c.aad(sealedRow));
      const where =
        c.scope === "tenant"
          ? sql`t.tenant_id = ${scope}::uuid AND t.id = ${uuid}::uuid`
          : sql`t.id = ${uuid}::uuid`;
      const bytea = c.encoding === "bytea";
      const updated = await tx.transaction(
        async (savepoint) =>
          (await savepoint.execute(
            bytea
              ? sql`UPDATE ${tableSql(c)} t SET ${col} = decode(${next}, 'base64') WHERE ${where} AND t.${col} = decode(${sealed}, 'base64')`
              : sql`UPDATE ${tableSql(c)} t SET ${col} = ${next} WHERE ${where} AND t.${col} = ${sealed}`,
          )) as unknown as ResultRows,
      );
      // 0 rows: the value changed under us (compare-and-set); the next pass
      // sees it again, it is neither resealed nor failed.
      if ((updated.rowCount ?? 0) > 0) resealed += 1;
    } catch {
      state.failed += 1;
    }
  }
  return { handled: result.rows.length, resealed };
}

type ScopeRun = SealedSecretColumnReport;

/** One column in one scope: batches until a pass finishes, then the counts. */
async function runScope(
  database: Database,
  c: SealedSecretColumn,
  scope: string,
  active: number,
  batchSize: number,
  options: SealedSecretResealOptions,
  result: { aborted: boolean },
): Promise<ScopeRun> {
  const inScope = <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
    c.scope === "tenant"
      ? withTenant(database, jobContext(scope), run)
      : database.transaction(run);
  let resealedTotal = 0;
  let failedTotal = 0;

  // A fully frozen column is only counted: SELECT ... FOR UPDATE would already
  // need the UPDATE privilege the app login does not have on it.
  if (!options.reportOnly && c.frozenWhere !== "true") {
    const state = await inScope((tx) => loadState(tx, c, scope, active));
    for (;;) {
      if (options.signal?.aborted) {
        result.aborted = true;
        break;
      }
      const batch = await inScope(async (tx) => {
        const outcome = await resealBatch(
          tx,
          c,
          scope,
          active,
          batchSize,
          state,
        );
        if (outcome.handled === 0) state.lastId = null;
        await saveState(tx, c, scope, active, state, outcome.resealed);
        return outcome;
      });
      resealedTotal += batch.resealed;
      if (batch.handled === 0) break;
      await options.afterBatch?.({
        table: c.table,
        column: c.column,
        scope,
        count: batch.resealed,
      });
    }
    failedTotal = state.failed;
  }

  // Counted without SKIP LOCKED: a row locked by someone else still counts.
  const remaining = await inScope((tx) =>
    countRows(tx, c, scope, active, false),
  );
  const frozen = await inScope((tx) => countRows(tx, c, scope, active, true));
  return { resealed: resealedTotal, failed: failedTotal, remaining, frozen };
}

/** Re-seal (or, with `reportOnly`, count) every stale row of every registry column. */
export async function runSealedSecretReseal(
  options: SealedSecretResealOptions = {},
): Promise<SealedSecretResealResult> {
  const database = options.database ?? db;
  const log = options.log ?? console;
  const batchSize = options.batchSize ?? SEALED_SECRET_RESEAL_BATCH;
  const active = options.activeKeyVersion ?? currentSealVersion();
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer");
  const columns = options.columns ?? SEALED_SECRET_COLUMNS;

  // A listing failure is not tenant-specific: fail the job so pg-boss retries.
  const tenantIds = columns.some((c) => c.scope === "tenant")
    ? await (options.listTenantIds ?? (() => listAllTenantIds(database)))()
    : [];
  const result: SealedSecretResealResult = {
    activeVersion: active,
    tables: {},
    failedTenants: 0,
    aborted: false,
  };
  for (const c of columns)
    result.tables[keyOf(c)] = {
      resealed: 0,
      failed: 0,
      remaining: 0,
      frozen: 0,
    };
  const failedTenants = new Set<string>();

  for (const c of columns) {
    const total = result.tables[keyOf(c)];
    if (!total) continue;
    const scopes = c.scope === "tenant" ? tenantIds : [GLOBAL_SCOPE];
    for (const scope of scopes) {
      if (result.aborted || options.signal?.aborted) {
        result.aborted = true;
        break;
      }
      try {
        const run = await runScope(
          database,
          c,
          scope,
          active,
          batchSize,
          options,
          result,
        );
        total.resealed += run.resealed;
        total.failed += run.failed;
        total.remaining += run.remaining;
        total.frozen += run.frozen;
      } catch {
        // Database error: this scope rolled back whole; the others still run.
        failedTenants.add(scope);
        total.failed += 1;
        log.error(
          `Sealed secret re-seal failed for ${keyOf(c)} scope ${scope} (details withheld)`,
        );
      }
    }
    if (result.aborted) break;
  }
  result.failedTenants = failedTenants.size;
  return result;
}

/** Rows a run could not or may not finish: not frozen, still stale or failed. */
export function sealedSecretUnresolved(
  result: SealedSecretResealResult,
): number {
  let n = 0;
  for (const report of Object.values(result.tables))
    n += Math.max(report.remaining - report.frozen, 0) + report.failed;
  return n;
}

type SealedSecretResealBoss = {
  createQueue(
    name: string,
    options?: { policy?: string; expireInSeconds?: number },
  ): Promise<void>;
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: { tz?: string },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
};

/**
 * Call after the boss has started. Weekly; `exclusive` keeps two runs apart.
 * A run with rows still stale (locked, failed, or a database error) fails the
 * job so pg-boss records it; a rerun only touches what is still stale.
 */
export async function registerSealedSecretResealJob(options: {
  boss: SealedSecretResealBoss;
  database?: Database;
  log?: Log;
  /** Test hook; defaults to every tenant. */
  listTenantIds?: () => Promise<string[]>;
}): Promise<void> {
  const { boss } = options;
  const log = options.log ?? console;
  await boss.createQueue(SEALED_SECRET_RESEAL_QUEUE, {
    policy: "exclusive",
    expireInSeconds: SEALED_SECRET_RESEAL_EXPIRE_SECONDS,
  });
  await boss.schedule(
    SEALED_SECRET_RESEAL_QUEUE,
    SEALED_SECRET_RESEAL_CRON,
    null,
    { tz: SEALED_SECRET_RESEAL_TZ },
  );
  await boss.work(SEALED_SECRET_RESEAL_QUEUE, async () => {
    try {
      const result = await runSealedSecretReseal({
        log,
        ...(options.database ? { database: options.database } : {}),
        ...(options.listTenantIds
          ? { listTenantIds: options.listTenantIds }
          : {}),
      });
      log.info(`Sealed secret re-seal finished ${JSON.stringify(result)}`);
      if (result.failedTenants > 0)
        throw new Error(
          `Sealed secret re-seal failed for ${result.failedTenants} scope(s)`,
        );
      const unresolved = sealedSecretUnresolved(result);
      if (unresolved > 0)
        throw new Error(
          `Sealed secret re-seal incomplete: ${unresolved} row(s) still stale or failed`,
        );
    } catch (error) {
      log.error(
        `Sealed secret re-seal job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}
