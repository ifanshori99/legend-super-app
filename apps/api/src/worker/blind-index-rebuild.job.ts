// Blind-index rebuild (bead legend-n039). Moves every row whose blind-index
// digests were written under another key version to the active version
// (BLIND_INDEX_ACTIVE_VERSION, lib/blind-index.ts): `employees` (all `*_hmac`
// columns, row version `blind_index_version`) and `legal_entities`
// (`npwp_hash`, row version `npwp_hash_version`). On demand only, no cron: an
// operator queues `blind-index-rebuild` with `{ targetVersion }` after a
// deploy, or after setting BLIND_INDEX_ACTIVE_VERSION=1 to roll back (rows move
// in both directions: the WHERE is `version <> active`).
//
// Verify mode (payload `{ targetVersion, verify: true }`) scans ALL rows, not
// only the ones marked stale: it recomputes the active digest of every row from
// its sealed value and rewrites any row whose stored digest or version differs
// (same lock and cross-version pre-check). A row can sit at the active version
// with a digest written by something else, so the version column alone proves
// nothing. The result reports the rewrites; a verify run with 0 rewrites, 0
// conflicts and 0 failed or incomplete tenants is the proof that a version is
// no longer needed.
//
// Verify cannot inspect a row another transaction has locked (SKIP LOCKED). It
// counts those rows as `skipped` (rows of the tenant minus rows it saw) and the
// tenant is then incomplete and retryable; a verify run is clean only with
// `skipped` 0 and `rewrites` 0 (legend-488). A locked row counts as skipped even
// when its digest is right: verify cannot know while it is locked.
//
// Built like worker/hris-pii-reseal.job.ts: batches of 200 ordered by id, one
// tenant transaction each, rows selected FOR UPDATE SKIP LOCKED, safe to repeat
// and to kill; a second run after a finished one changes 0 rows. After the
// batches the job counts what is still stale WITHOUT skipping locks and fails
// when a tenant has leftovers, so pg-boss retries. Every tenant is covered
// whatever its status. The sealed columns and `updated_at` are not touched:
// the data did not change, only its index.
//
// Unique indexes are (tenant, digest), so a version 1 row and a version 2 row
// of the same value do not collide. The job therefore takes the tenant's
// blind-index lock (the one writers take) per batch and checks the new digest
// against every other row before it rewrites a row. A clash leaves the row at
// its old version and is counted as a conflict (tenant id, row id and column
// name are logged, never a value); that tenant is reported incomplete. A
// conflict does not fail the job (retrying cannot fix it, a person must fix the
// data); stale rows that are not conflicts (locked by another transaction) do.
//
// Logs carry counts, ids and column names only, never values or keys.

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { employees } from "../db/schema/hris.ts";
import { legalEntities } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
  blindIndexCandidates,
  type BlindIndexVersion,
} from "../lib/blind-index.ts";
import {
  hrisBlindIndex,
  hrisBlindIndexCandidates,
  normalizeHrisPii,
  openHrisPii,
  type HrisEmployeePiiField,
} from "../lib/hris-pii.ts";
import { openSecret } from "../lib/secrets.ts";
import { listAllTenantIds } from "./hris-pii-reseal.job.ts";

type Database = NodePgDatabase<typeof schema>;

export const BLIND_INDEX_REBUILD_QUEUE = "blind-index-rebuild";
export const BLIND_INDEX_REBUILD_BATCH = 200;
/** One run may be long on a big tenant; pg-boss must not expire it early. */
const BLIND_INDEX_REBUILD_EXPIRE_SECONDS = 60 * 60;

export type BlindIndexRebuildResult = {
  tenants: number;
  employees: number;
  legalEntities: number;
  /** Rows left at their old version because the new digest clashes with another row. */
  conflicts: number;
  failedTenants: number;
  /** Tenants that still hold stale rows after the run (conflicts, locked rows). */
  incompleteTenants: number;
  /** True when the abort signal stopped the run before it was done. */
  aborted: boolean;
  /** True for a verify run (all rows scanned, not only stale ones). */
  verify: boolean;
  /** Rows rewritten by this run (`employees + legalEntities`); a verify run must end at 0. */
  rewrites: number;
  /** Tenants with stale rows that are not conflicts (locked rows): a retry can finish them. */
  retryableTenants: number;
  /** Verify only: rows it could not inspect because another transaction held the lock. */
  skipped: number;
};

export type BlindIndexRebuildOptions = {
  database?: Database;
  log?: Pick<Console, "error">;
  /** Rows per batch (one transaction each). */
  batchSize?: number;
  /** Version to move rows to; defaults to the configured active version. */
  activeVersion?: BlindIndexVersion;
  /** Scan every row, not only stale ones, and rewrite any digest that differs. */
  verify?: boolean;
  /** Stops the run cleanly between batches (shutdown, test). */
  signal?: AbortSignal;
  /** Called after each committed batch; a throw fails that tenant's run. */
  afterBatch?: (batch: {
    tenantId: string;
    table: "employees" | "legal_entities";
    count: number;
  }) => void | Promise<void>;
  /** Test hook; defaults to every tenant, whatever its status. */
  listTenantIds?: () => Promise<string[]>;
};

/** Indexed employee fields: wire field, sealed column, blind-index column. */
const EMPLOYEE_INDEXES = [
  ["nik", "nikEncrypted", "nikHmac"],
  ["npwp", "npwpEncrypted", "npwpHmac"],
  ["bpjsKesNo", "bpjsKesNoEncrypted", "bpjsKesNoHmac"],
  ["bpjsTkNo", "bpjsTkNoEncrypted", "bpjsTkNoHmac"],
  ["bankAccount", "bankAccountEncrypted", "bankAccountHmac"],
] as const satisfies readonly (readonly [
  HrisEmployeePiiField,
  keyof typeof employees.$inferSelect,
  keyof typeof employees.$inferSelect,
])[];

/** Fields with a unique index (bank account is lookup only: no clash possible). */
const UNIQUE_EMPLOYEE_FIELDS: ReadonlySet<HrisEmployeePiiField> = new Set([
  "nik",
  "npwp",
  "bpjsKesNo",
  "bpjsTkNo",
]);

type BatchOutcome = {
  moved: number;
  conflicts: number;
  /** Conflicts whose row is still on another version (counted by `countStale`). */
  staleConflicts: number;
  seen: number;
};

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/** Rows of a tenant still on another version, counted without SKIP LOCKED. */
async function countStale(
  database: Database,
  context: ScopedTenantContext,
  active: BlindIndexVersion,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    const [staleEmployees] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          ne(employees.blindIndexVersion, active),
        ),
      );
    const [staleEntities] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.tenantId, tenantId),
          ne(legalEntities.npwpHashVersion, active),
        ),
      );
    return Number(staleEmployees?.n ?? 0) + Number(staleEntities?.n ?? 0);
  });
}

/** Rows of a tenant per table, counted without SKIP LOCKED (verify skip check). */
async function countRows(
  database: Database,
  context: ScopedTenantContext,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    const [rowsEmployees] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employees)
      .where(eq(employees.tenantId, tenantId));
    const [rowsEntities] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId));
    return Number(rowsEmployees?.n ?? 0) + Number(rowsEntities?.n ?? 0);
  });
}

async function lockTenantBlindIndex(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blind-index:${tenantId}`}, 0))`,
  );
}

/**
 * One batch of employees. A row moves only when none of its unique digests
 * under the new version (or the old one) belongs to another row. Rows skipped
 * for a conflict stay stale, so the next batch must not select them again:
 * the cursor `afterId` walks past them.
 */
async function rebuildEmployeeBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: BlindIndexVersion,
  afterId: string | null,
  log: Pick<Console, "error">,
  verify: boolean,
): Promise<BatchOutcome & { lastId: string | null }> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await lockTenantBlindIndex(tx, tenantId);
    const rows = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          ...(verify ? [] : [ne(employees.blindIndexVersion, active)]),
          ...(afterId === null ? [] : [sql`${employees.id} > ${afterId}`]),
        ),
      )
      .orderBy(asc(employees.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    let moved = 0;
    let conflicts = 0;
    let staleConflicts = 0;
    for (const row of rows) {
      const values: Partial<typeof employees.$inferInsert> = {};
      const opened: {
        field: HrisEmployeePiiField;
        hmacColumn: (typeof EMPLOYEE_INDEXES)[number][2];
        value: string;
      }[] = [];
      for (const [field, sealedColumn, hmacColumn] of EMPLOYEE_INDEXES) {
        const sealed = row[sealedColumn];
        if (sealed === null) continue;
        const value = normalizeHrisPii(
          field,
          openHrisPii(
            sealed,
            { tenantId, table: "employees", rowId: row.id, field },
            row.piiKeyVersion,
          ),
        );
        values[hmacColumn] = hrisBlindIndex(field, tenantId, value, active);
        opened.push({ field, hmacColumn, value });
      }
      // Verify: a row already holding the active version and every active
      // digest needs no write and no pre-check.
      if (
        verify &&
        row.blindIndexVersion === active &&
        opened.every(({ hmacColumn }) => row[hmacColumn] === values[hmacColumn])
      )
        continue;
      let clash: string | null = null;
      for (const { field, hmacColumn, value } of opened) {
        if (clash === null && UNIQUE_EMPLOYEE_FIELDS.has(field)) {
          const digests = hrisBlindIndexCandidates(field, tenantId, value).map(
            (candidate) => candidate.digest,
          );
          const [hit] = await tx
            .select({ id: employees.id })
            .from(employees)
            .where(
              and(
                eq(employees.tenantId, tenantId),
                inArray(employees[hmacColumn], digests),
                ne(employees.id, row.id),
              ),
            )
            .limit(1);
          if (hit) clash = hmacColumn;
        }
      }
      if (clash !== null) {
        conflicts += 1;
        if (row.blindIndexVersion !== active) staleConflicts += 1;
        log.error(
          `Blind-index rebuild conflict for tenant ${tenantId}: employee ${row.id} shares a value in column ${clash} with another employee; left at version ${row.blindIndexVersion}`,
        );
        continue;
      }
      await tx
        .update(employees)
        .set({ ...values, blindIndexVersion: active })
        .where(and(eq(employees.tenantId, tenantId), eq(employees.id, row.id)));
      moved += 1;
    }
    return {
      moved,
      conflicts,
      staleConflicts,
      seen: rows.length,
      lastId: rows.at(-1)?.id ?? null,
    };
  });
}

/** One batch of legal entities; same rules as `rebuildEmployeeBatch`. */
async function rebuildLegalEntityBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: BlindIndexVersion,
  afterId: string | null,
  log: Pick<Console, "error">,
  verify: boolean,
): Promise<BatchOutcome & { lastId: string | null }> {
  const tenantId = context.tenant.tenantId;
  const purpose = `legal_entity-npwp:${tenantId}`;
  return withTenant(database, context, async (tx) => {
    await lockTenantBlindIndex(tx, tenantId);
    const rows = await tx
      .select()
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.tenantId, tenantId),
          ...(verify ? [] : [ne(legalEntities.npwpHashVersion, active)]),
          ...(afterId === null ? [] : [sql`${legalEntities.id} > ${afterId}`]),
        ),
      )
      .orderBy(asc(legalEntities.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    let moved = 0;
    let conflicts = 0;
    let staleConflicts = 0;
    for (const row of rows) {
      let npwpHash: string | null = null;
      const npwp =
        row.npwpEncrypted === null
          ? null
          : openSecret(row.npwpEncrypted, `legal_entity:${tenantId}`);
      if (npwp !== null) npwpHash = blindIndexAt(active, npwp, purpose);
      if (verify && row.npwpHashVersion === active && row.npwpHash === npwpHash)
        continue;
      if (npwp !== null) {
        const digests = blindIndexCandidates(npwp, purpose).map(
          (candidate) => candidate.digest,
        );
        const [hit] = await tx
          .select({ id: legalEntities.id })
          .from(legalEntities)
          .where(
            and(
              eq(legalEntities.tenantId, tenantId),
              inArray(legalEntities.npwpHash, digests),
              ne(legalEntities.id, row.id),
            ),
          )
          .limit(1);
        if (hit) {
          conflicts += 1;
          if (row.npwpHashVersion !== active) staleConflicts += 1;
          log.error(
            `Blind-index rebuild conflict for tenant ${tenantId}: legal entity ${row.id} shares a value in column npwp_hash with another legal entity; left at version ${row.npwpHashVersion}`,
          );
          continue;
        }
      }
      await tx
        .update(legalEntities)
        .set({ npwpHash, npwpHashVersion: active })
        .where(
          and(
            eq(legalEntities.tenantId, tenantId),
            eq(legalEntities.id, row.id),
          ),
        );
      moved += 1;
    }
    return {
      moved,
      conflicts,
      staleConflicts,
      seen: rows.length,
      lastId: rows.at(-1)?.id ?? null,
    };
  });
}

/** Rebuild every stale row of every tenant (verify: every row, stale or not). */
export async function runBlindIndexRebuild(
  options: BlindIndexRebuildOptions = {},
): Promise<BlindIndexRebuildResult> {
  const database = options.database ?? db;
  const log = options.log ?? console;
  const batchSize = options.batchSize ?? BLIND_INDEX_REBUILD_BATCH;
  const active = options.activeVersion ?? BLIND_INDEX_ACTIVE_VERSION;
  const verify = options.verify === true;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer");

  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and a retry picks up from the database state.
  const tenantIds = await (
    options.listTenantIds ?? (() => listAllTenantIds(database))
  )();
  const result: BlindIndexRebuildResult = {
    tenants: tenantIds.length,
    employees: 0,
    legalEntities: 0,
    conflicts: 0,
    failedTenants: 0,
    incompleteTenants: 0,
    aborted: false,
    verify,
    rewrites: 0,
    retryableTenants: 0,
    skipped: 0,
  };

  const steps = [
    ["employees", rebuildEmployeeBatch],
    ["legal_entities", rebuildLegalEntityBatch],
  ] as const;
  for (const tenantId of tenantIds) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const context = jobContext(tenantId);
    assertTrustedScopedContext(context);
    let tenantStaleConflicts = 0;
    let tenantSeen = 0;
    try {
      for (const [table, runBatch] of steps) {
        let afterId: string | null = null;
        for (;;) {
          if (options.signal?.aborted) {
            result.aborted = true;
            break;
          }
          const batch: BatchOutcome & { lastId: string | null } =
            await runBatch(
              database,
              context,
              batchSize,
              active,
              afterId,
              log,
              verify,
            );
          if (batch.seen === 0) break;
          afterId = batch.lastId;
          tenantSeen += batch.seen;
          result.conflicts += batch.conflicts;
          tenantStaleConflicts += batch.staleConflicts;
          if (table === "employees") result.employees += batch.moved;
          else result.legalEntities += batch.moved;
          if (batch.moved > 0)
            await options.afterBatch?.({ tenantId, table, count: batch.moved });
        }
        if (result.aborted) break;
      }
      if (!result.aborted) {
        const stale = await countStale(database, context, active);
        // Verify scans every row: any row it did not see was locked by another
        // transaction (or is new), so the proof is not complete yet.
        const skipped = verify
          ? Math.max(0, (await countRows(database, context)) - tenantSeen)
          : 0;
        result.skipped += skipped;
        if (stale > 0 || skipped > 0) {
          result.incompleteTenants += 1;
          log.error(
            `Blind-index rebuild incomplete for tenant ${tenantId}: rows still on another version or not inspected (conflicts, or locked by another transaction)`,
          );
          // Stale rows beyond the conflicts, or skipped rows, were locked: a retry can finish them.
          if (stale > tenantStaleConflicts || skipped > 0)
            result.retryableTenants += 1;
        }
      }
    } catch (error) {
      result.failedTenants += 1;
      log.error(
        `Blind-index rebuild failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    if (result.aborted) break;
  }
  result.rewrites = result.employees + result.legalEntities;
  return result;
}

type BlindIndexRebuildBoss = {
  createQueue(
    name: string,
    options?: { policy?: string; expireInSeconds?: number },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
};

/** Job payload: `verify: true` asks for a full scan, see the header. */
function isVerifyJob(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { verify?: unknown }).verify === true
  );
}

/** Job payload: the version the operator meant to move rows to. */
function assertTargetVersion(data: unknown, active: number): void {
  const target =
    typeof data === "object" && data !== null
      ? (data as { targetVersion?: unknown }).targetVersion
      : undefined;
  if (target !== active)
    throw new Error(
      "Blind-index rebuild refused: job targetVersion is missing or differs from this worker's active blind-index version",
    );
}

/**
 * Call after the boss has started. On demand only: queue a job named
 * `blind-index-rebuild` with data `{ targetVersion }` (add `verify: true` for
 * the full-scan proof run). `exclusive` keeps two runs apart.
 */
export async function registerBlindIndexRebuildJob(options: {
  boss: BlindIndexRebuildBoss;
  database?: Database;
  log?: Pick<Console, "error" | "info">;
  /** Test hook; defaults to every tenant. */
  listTenantIds?: () => Promise<string[]>;
}): Promise<void> {
  const { boss } = options;
  const log = options.log ?? console;
  await boss.createQueue(BLIND_INDEX_REBUILD_QUEUE, {
    policy: "exclusive",
    expireInSeconds: BLIND_INDEX_REBUILD_EXPIRE_SECONDS,
  });
  await boss.work(BLIND_INDEX_REBUILD_QUEUE, async (jobs) => {
    try {
      // Refuse before any write when a job targets another version.
      for (const job of jobs)
        assertTargetVersion(job.data, BLIND_INDEX_ACTIVE_VERSION);
      const result = await runBlindIndexRebuild({
        log,
        verify: jobs.some((job) => isVerifyJob(job.data)),
        ...(options.database ? { database: options.database } : {}),
        ...(options.listTenantIds
          ? { listTenantIds: options.listTenantIds }
          : {}),
      });
      log.info(`Blind-index rebuild finished ${JSON.stringify(result)}`);
      // A failed tenant, or one with locked stale rows, fails the job so
      // pg-boss records it and retries; a rerun is safe and only touches the
      // rows still stale. A conflict is permanent (the data needs a person):
      // it is logged and counted in the result but does not fail the job, so
      // pg-boss does not retry it forever. The operator reads `conflicts`.
      if (result.failedTenants > 0)
        throw new Error(
          `Blind-index rebuild failed for ${result.failedTenants} tenant(s)`,
        );
      if (result.retryableTenants > 0)
        throw new Error(
          `Blind-index rebuild incomplete for ${result.retryableTenants} tenant(s): rows still on another version`,
        );
      if (result.conflicts > 0)
        log.error(
          `Blind-index rebuild finished with ${result.conflicts} conflict(s): fix the duplicate values, then queue the job again (not retried automatically)`,
        );
    } catch (error) {
      log.error(
        `Blind-index rebuild job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}
