// Write idempotency for daily-operations mutations (contract `idempotencyKey`;
// docs/plan/contracts.md D-CORE-5). Every create endpoint binds its client key
// to a fingerprint of the request and to the document it created, inside the
// same tenant transaction. A replay with the same fingerprint returns the
// recorded document id; reusing a key with a different payload answers
// IDEMPOTENCY_KEY_REUSED (409) instead of creating a second document.
//
// The shared table is `operations_idempotency` (schema/operations.ts); the
// checklist, food-safety, prep, equipment, maintenance and handover services
// all use these two helpers so the behaviour cannot drift between them.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  CoreError,
  idempotencyKeySchema,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema/index.ts";
import { operationsIdempotency } from "../db/schema/operations.ts";

type Database = NodePgDatabase<typeof schema>;
export type OperationsTx = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** Stable serialisation: sorted object keys, arrays in order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** SHA-256 of the canonical request payload (never the idempotency key). */
export function operationsFingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * The recorded document for this key, or null when the key is new. A key that
 * was already used for a different payload (or a different result kind) is a
 * reuse error, never a silent second write.
 */
export async function readIdempotentResult(
  tx: OperationsTx,
  context: ScopedTenantContext,
  key: string,
  fingerprint: string,
  resultTable: string,
): Promise<string | null> {
  const parsedKey = idempotencyKeySchema.parse(key);
  // Serialise concurrent requests carrying the same key: without this lock two
  // racing first attempts both miss the row and the loser fails on the
  // (tenant_id, key) unique constraint with a 500 instead of a replay.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`operations-idempotency:${context.tenant.tenantId}:${parsedKey}`}))`,
  );
  const [row] = await tx
    .select()
    .from(operationsIdempotency)
    .where(
      and(
        eq(operationsIdempotency.tenantId, context.tenant.tenantId),
        eq(operationsIdempotency.key, parsedKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.fingerprint !== fingerprint || row.resultTable !== resultTable)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai permintaan lain.",
    );
  return row.resultId;
}

/** Bind a key to the created document in the caller's transaction. */
export async function storeIdempotentResult(
  tx: OperationsTx,
  context: ScopedTenantContext,
  input: {
    key: string;
    fingerprint: string;
    outletId: string;
    resultTable: string;
    resultId: string;
  },
): Promise<void> {
  await tx.insert(operationsIdempotency).values({
    tenantId: context.tenant.tenantId,
    outletId: outletIdSchema.parse(input.outletId),
    key: idempotencyKeySchema.parse(input.key),
    fingerprint: input.fingerprint,
    resultTable: input.resultTable,
    resultId: input.resultId,
  });
}
