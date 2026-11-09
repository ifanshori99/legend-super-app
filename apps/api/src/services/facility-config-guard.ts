// Concurrency and replay guards of the facility config writes (bead
// legend-6jms; PRD v1.7 §3 F22/F25).
//
// - `assertConfigFresh`: PATCH/PUT carry the `updatedAt` the editor last read
//   (`expectedUpdatedAt`); a different value means another admin saved first,
//   so the write answers 412 (CoreError PRECONDITION_FAILED, as the inventory
//   writes do) instead of overwriting (last-write-wins is gone).
// - `createOnce`: every POST create carries an `idempotencyKey`. The key is
//   bound to a fingerprint of the payload and to the created row inside the
//   caller's tenant transaction (operations-idempotency.ts). A replay returns
//   the first row; the same key with another payload answers
//   IDEMPOTENCY_KEY_REUSED (409).
// - `storeFacilityIdempotentResult`: the key is unique per tenant, but the
//   lookup is narrowed to the caller's outlets by RLS. A key first used on
//   another outlet is invisible to the lookup, so the store hits the unique
//   constraint; that is the same reuse error (409), never a 500.
import { sql } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  operationsFingerprint,
  readIdempotentResult,
  storeIdempotentResult,
} from "./operations-idempotency.ts";
import { notFound, type Tx } from "./facility-shared.ts";

/**
 * 412 PRECONDITION_FAILED unless the stored `updatedAt` is the one the editor read. `null` means
 * "I expect no row yet" and is only valid for an upsert whose row is absent.
 * Millisecond comparison: the contract and `Date` both stop at milliseconds.
 */
export function assertConfigFresh(
  current: Date | null,
  expected: string | null,
): void {
  const fresh =
    current === null || expected === null
      ? current === null && expected === null
      : current.getTime() === new Date(expected).getTime();
  if (!fresh)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Data sudah diubah orang lain. Muat ulang lalu coba lagi.",
    );
}

/** Config tables the update paths lock (names are code constants). */
export type LockableConfigTable =
  | "facility_areas"
  | "facility_units"
  | "facility_products"
  | "facility_addons"
  | "facility_subscription_plans";

/**
 * Row lock for the read-check-write of an update: call after the permission
 * check and read the row again afterwards, so the stamp that is compared is
 * the one the write replaces. RLS still applies to the lock.
 */
export async function lockConfigRow(
  tx: Tx,
  table: LockableConfigTable,
  context: ScopedTenantContext,
  id: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM ${sql.identifier(table)} WHERE tenant_id = ${context.tenant.tenantId} AND id = ${id} FOR UPDATE`,
  );
}

type StoreInput = Parameters<typeof storeIdempotentResult>[2];

/** Postgres unique violation, bare or wrapped by drizzle (`cause`). */
function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause && typeof cause === "object";) {
    const record = cause as { code?: unknown; cause?: unknown };
    if (record.code === "23505") return true;
    cause = record.cause;
  }
  return false;
}

/**
 * `storeIdempotentResult` for the facility writers: a key already bound to
 * another outlet (hidden from the lookup by outlet RLS) answers
 * IDEMPOTENCY_KEY_REUSED (409) instead of a 500. The insert runs in a
 * savepoint, so the caller's transaction stays usable until it rolls back.
 */
export async function storeFacilityIdempotentResult(
  tx: Tx,
  context: ScopedTenantContext,
  input: StoreInput,
): Promise<void> {
  try {
    await tx.transaction((savepoint) =>
      storeIdempotentResult(savepoint, context, input),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai permintaan lain.",
    );
  }
}

/**
 * Runs one create once per idempotency key. Call after the permission check,
 * so a replay never answers a caller that may not write. `load` reads the row
 * the first attempt created.
 */
export async function createOnce<Row extends { id: string }, Mapped>(
  tx: Tx,
  context: ScopedTenantContext,
  args: {
    idempotencyKey: string;
    /** The request body without the key: what the fingerprint covers. */
    payload: unknown;
    outletId: string;
    resultTable: string;
    load: (id: string) => Promise<Row | undefined>;
    create: () => Promise<Row>;
    map: (row: Row) => Mapped;
    /** Name used in the 404 of a replay whose row no longer exists. */
    label: string;
  },
): Promise<Mapped> {
  const fingerprint = operationsFingerprint(args.payload);
  const priorId = await readIdempotentResult(
    tx,
    context,
    args.idempotencyKey,
    fingerprint,
    args.resultTable,
  );
  if (priorId !== null) {
    const prior = await args.load(priorId);
    if (!prior) throw notFound(args.label);
    return args.map(prior);
  }
  const row = await args.create();
  await storeFacilityIdempotentResult(tx, context, {
    key: args.idempotencyKey,
    fingerprint,
    outletId: args.outletId,
    resultTable: args.resultTable,
    resultId: row.id,
  });
  return args.map(row);
}
