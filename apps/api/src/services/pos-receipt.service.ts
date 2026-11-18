// POS receipt numbering (bead legend-93a, WS-04; PRD v1.7 §3 F8 "Nomor Struk
// Berurutan", §6 C `receipt_sequences`; POS-06; contract
// @starter/shared/pos receipts.ts).
//
// - One CURRENT `receipt_sequences` row (retired_at IS NULL) per (tenant,
//   outlet, device); a sale without a device (cloud / back-office POS) uses the
//   outlet id as its device key and the fixed prefix `C`. Device sequences are
//   `P1, P2, ...`; an edge never creates one and refuses a sale without a
//   verified device.
// - legend-zsdd: a sequence's counter lives in exactly ONE database. Both
//   `edge_node_id` and `edge_instance_id` NULL: the cloud holds it; both set:
//   the edge database `edge_instance_id` of node `edge_node_id` holds it. A
//   run that may have numbered elsewhere is never continued: it is retired
//   (`retired_at`, never numbers again) and the device continues under a NEW
//   prefix. Prefixes are never reused in an outlet (retired rows included), so
//   numbers never repeat. Retired runs still merge and still report gaps.
// - Allocation is gapless because it runs inside the sale transaction: the
//   UPDATE ... last_number + 1 row lock serialises devices and a rollback of
//   the sale rolls the number back with it. Idempotent per order.
// - A void never returns a number: the row flips to `voided` and stays.
// - Cloud merge of an offline device run (`mergeDeviceReceiptRun`) backfills
//   missing ordinals (late/reversed batches too), is an idempotent replay and
//   advances `lastNumber` only over a complete 1..n run (else
//   RECEIPT_SEQUENCE_GAP, nothing written). It refuses the outlet-owned
//   (cloud) sequence and prefix `C`, receipts whose order is not completed on
//   the same tenant, outlet and device, a device void with no
//   matching cloud void row, and an ordinal that is already taken by another receipt.
// - legend-yd0h8: a restored or cloned edge database keeps its instance id, so
//   its old runs would number again. A pull that sends `receiptRuns` reports
//   the edge's local counter per run; the cloud keeps a never-decreasing
//   high-water (`edge_reported_number`) and, when a report falls below it,
//   retires the run (`edge_regressed`) so the device continues under a new
//   prefix. At most RECEIPT_REGRESSION_ROTATIONS_MAX such rotations per device
//   in RECEIPT_REGRESSION_WINDOW_HOURS (two live databases on one node id);
//   beyond that the run is kept and an alert is raised. Every retire path
//   stores its reason (`retired_reason`). Reports are ordered by a token, the
//   CLOUD time the request reached the cloud (not the edge clock, which a
//   restored box may have behind or ahead): one not newer than the report that
//   last raised the high-water (`edge_reported_at`) is stale (a request that
//   timed out and arrived late) and is skipped, never read as a regression.
//   The puller is single-flight, so arrival order is read order. A merge that
//   advances a live edge-owned run stamps `edge_reported_at` too (legend-ol6v).
//   Limits, stated plainly: (1) sales between a restore and the first
//   successful pull still reuse numbers already issued (only legend-ol6v receipt
//   events can catch them); a backup newer than the last pull is not seen.
//   (2) a clone is an ALARM, not prevention: both databases receive the new
//   prefix, so numbers may collide until the manual zsdd procedure is done.
// The database triggers in pos-receipt.custom.sql are the backstop.

import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  CoreError,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  assertReceiptMatchesSequence,
  CLOUD_RECEIPT_PREFIX,
  formatReceiptNumber,
  RECEIPT_MAX_ORDINAL,
  posReceiptSchema,
  PosError,
  receiptGaps,
  receiptPrefixSchema,
  receiptSequenceSchema,
  voidReasonSchema,
  type PosReceipt,
  type ReceiptSequence,
} from "@starter/shared/pos";
import type {
  DeviceReceiptSequenceBinding,
  DeviceReceiptSequenceSync,
  ReceiptRunRefusalReport,
  ReceiptRunReport,
} from "@starter/shared/edge";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import type { PosReceiptGapRun } from "./pos-shift-ports.ts";
import { devices } from "../db/schema/device.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { posOrders, posOrderVoids } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { legalEntities, outlets } from "../db/schema/platform-org.ts";
import {
  posReceipts,
  receiptSequences,
  type PosReceiptOutletSnapshot,
  type ReceiptSequenceRetiredReason,
} from "../db/schema/pos-receipt.ts";
import { receiptNumberWriteoffs } from "../db/schema/pos-receipt-writeoff.ts";
import type { PosReceiptPort } from "./pos-order-ports.ts";
import { reportReceiptsArrivedAfterWriteoff } from "./pos-receipt-writeoff-arrival.ts";
import type { Tx } from "./permission-resolver.ts";

type ReceiptRow = typeof posReceipts.$inferSelect;
type SequenceRow = typeof receiptSequences.$inferSelect;

export function toPosReceipt(row: ReceiptRow): PosReceipt {
  return posReceiptSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    deviceId: row.deviceId,
    number: row.number,
    sequenceNumber: row.sequenceNumber,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedBy: row.voidedBy,
    reprintCount: row.reprintCount,
  });
}

function toReceiptSequence(row: SequenceRow): ReceiptSequence {
  return receiptSequenceSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    deviceId: row.deviceId,
    prefix: row.prefix,
    lastNumber: row.lastNumber,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Serialises sequence creation per outlet (prefix choice, device rows). */
async function lockOutletSequences(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`receipt_seq:${tenantId}:${outletId}`}, 0))`,
  );
}

/** The device's current (not retired) sequence; legend-zsdd. */
async function findSequenceRow(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  deviceId: string,
): Promise<SequenceRow | undefined> {
  const [row] = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId),
        eq(receiptSequences.deviceId, deviceId),
        isNull(receiptSequences.retiredAt),
      ),
    );
  return row;
}

/** Every prefix of the outlet, retired runs included (never reused). */
async function prefixesOfOutlet(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      prefix: receiptSequences.prefix,
      deviceId: receiptSequences.deviceId,
    })
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId),
      ),
    );
  return new Map(rows.map((row) => [row.prefix, row.deviceId]));
}

/**
 * First of `P1`, `P2`, ... not used by any row of the outlet, retired runs
 * included (legend-zsdd: a prefix never numbers twice).
 */
function nextFreePrefix(used: ReadonlyMap<string, string>): string {
  for (let n = 1; ; n += 1) if (!used.has(`P${n}`)) return `P${n}`;
}

/** Number of a `P<n>` prefix (at most 11 digits), 0 for any other string. */
function prefixNumber(prefix: string): number {
  const match = /^P(\d{1,11})$/.exec(prefix);
  return match ? Number(match[1]) : 0;
}

/**
 * First `P<n>` with n above `floor`, not used by any row of the outlet
 * (legend-hfq3z). Falls back to `nextFreePrefix` when the prefix would be
 * longer than 12 characters.
 */
function nextFreePrefixAbove(
  used: ReadonlyMap<string, string>,
  floor: number,
): string {
  for (let n = floor + 1; ; n += 1) {
    const prefix = `P${n}`;
    if (prefix.length > 12) return nextFreePrefix(used);
    if (!used.has(prefix)) return prefix;
  }
}

/** New sequence at 0; `binding` set = the counter lives on that edge (legend-zsdd). */
async function insertSequence(
  tx: Tx,
  input: {
    tenantId: TenantId;
    outletId: OutletId;
    deviceId: string;
    prefix: string;
    binding?: DeviceReceiptSequenceBinding;
  },
): Promise<SequenceRow> {
  const [row] = await tx
    .insert(receiptSequences)
    .values({
      tenantId: input.tenantId,
      outletId: input.outletId,
      deviceId: input.deviceId,
      prefix: input.prefix,
      lastNumber: 0,
      edgeNodeId: input.binding?.edgeNodeId ?? null,
      edgeInstanceId: input.binding?.edgeInstanceId ?? null,
    })
    .returning();
  if (!row) throw new Error("Receipt sequence insert returned no row");
  return row;
}

/**
 * legend-zsdd: closes a run for good; the device continues under a new prefix.
 * legend-yd0h8: `reason` is stored in `retired_reason` (audit, rate limit).
 * `stampReportedAt` also moves `edge_reported_at` (an `edge_regressed` retire:
 * a later, older report of this run must not look newer than the retire).
 * legend-hfq3z: `retiredAt` (default `now()`) lets the self-heal retire set
 * `retired_at` and `edge_reported_at` to the same instant, which marks a heal
 * row (`claim_rotated` with `retired_at = edge_reported_at`).
 */
async function retireSequence(
  tx: Tx,
  tenantId: TenantId,
  sequenceId: string,
  reason: ReceiptSequenceRetiredReason,
  stampReportedAt?: Date,
  retiredAt?: Date,
): Promise<void> {
  const [row] = await tx
    .update(receiptSequences)
    .set({
      retiredAt: retiredAt ?? sql`now()`,
      retiredReason: reason,
      ...(stampReportedAt === undefined
        ? {}
        : { edgeReportedAt: stampReportedAt }),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, sequenceId),
        isNull(receiptSequences.retiredAt),
      ),
    )
    .returning({ id: receiptSequences.id });
  if (!row) throw new Error("Receipt sequence retire returned no row");
}

/**
 * Edge (legend-zsdd, review K R1-A): a bound row numbers only in the database
 * it is bound to, i.e. this database's own `edge_nodes` row has the row's node
 * id AND instance id. This is what makes the restore procedure work: resetting
 * `edge_nodes.instance_id` on a restored or cloned edge database stops its old
 * runs from numbering until a pull rotates them to new prefixes. Rows with a
 * NULL binding (3yqy-era) stay usable; the next pull binds them.
 */
async function boundToThisDatabase(
  tx: Tx,
  tenantId: TenantId,
  row: SequenceRow,
): Promise<boolean> {
  if (row.edgeNodeId === null || row.edgeInstanceId === null) return false;
  const [own] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.id, row.edgeNodeId),
        eq(edgeNodes.instanceId, row.edgeInstanceId),
      ),
    )
    .limit(1);
  return own !== undefined;
}

/**
 * Existing sequence of the key. The outlet id key is the cloud-owned sequence
 * (prefix `C`). A device key gets a new row with the next free `P<n>` prefix in
 * the cloud; an edge never invents one (the cloud provisions it first).
 * legend-zsdd: in the cloud, a device's current sequence bound to an edge is
 * never continued (the edge may have numbered on it); it is retired and the
 * device continues under a new unbound prefix. An edge process numbers only
 * on an unbound row or a row bound to this very database
 * (`boundToThisDatabase`); otherwise RECEIPT_SEQUENCE_NOT_PROVISIONED.
 */
async function ensureSequence(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  deviceId: string,
): Promise<SequenceRow> {
  // Not a type guard: `false` must not narrow a bound row to `undefined`.
  const usable = async (row: SequenceRow): Promise<boolean> =>
    row.edgeNodeId === null ||
    (isEdgeProcess() && (await boundToThisDatabase(tx, tenantId, row)));
  const existing = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (existing && (await usable(existing))) return existing;
  const cloudOwned = deviceId === outletId;
  if (!cloudOwned && isEdgeProcess())
    throw new PosError("RECEIPT_SEQUENCE_NOT_PROVISIONED");
  await lockOutletSequences(tx, tenantId, outletId);
  // Another sale may have created it while this one waited for the lock.
  const created = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (created && (await usable(created))) return created;
  if (created) {
    // legend-zsdd: the current row is bound to an edge (cloud process only).
    // Sequence `C` is never claimed by an edge (prefix `C` cannot be reused).
    if (cloudOwned)
      throw new Error("Cloud-owned receipt sequence is bound to an edge");
    await retireSequence(tx, tenantId, created.id, "cloud_takeover");
  } else if (cloudOwned)
    return insertSequence(tx, {
      tenantId,
      outletId,
      deviceId,
      prefix: CLOUD_RECEIPT_PREFIX,
    });
  const used = await prefixesOfOutlet(tx, tenantId, outletId);
  return insertSequence(tx, {
    tenantId,
    outletId,
    deviceId,
    prefix: nextFreePrefix(used),
  });
}

export async function findReceiptForOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<PosReceipt | null> {
  const [row] = await tx
    .select()
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, context.tenant.tenantId),
        eq(posReceipts.orderId, orderId),
      ),
    );
  return row ? toPosReceipt(row) : null;
}

export async function findReceiptById(
  tx: Tx,
  context: ScopedTenantContext,
  receiptId: string,
): Promise<PosReceipt | null> {
  const [row] = await tx
    .select()
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, context.tenant.tenantId),
        eq(posReceipts.id, receiptId),
      ),
    );
  return row ? toPosReceipt(row) : null;
}

export async function findReceiptByNumber(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  number: string,
): Promise<PosReceipt | null> {
  const [row] = await tx
    .select()
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, context.tenant.tenantId),
        eq(posReceipts.outletId, outletId as OutletId),
        eq(posReceipts.number, number),
      ),
    );
  return row ? toPosReceipt(row) : null;
}

/**
 * Outlet name/address and legal entity name/NPWP tail as they are at issue
 * time. Stored on the receipt so later outlet edits never rewrite a printed
 * document.
 */
const optionalText = (value: unknown) =>
  value === null || typeof value === "string";

/** Shape check for a device-supplied header (the DB checks name/address only). */
function isOutletSnapshot(value: unknown): value is PosReceiptOutletSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((key) =>
      ["outletName", "outletAddress", "legalName", "npwpLast4"].includes(key),
    ) &&
    typeof v.outletName === "string" &&
    v.outletName.length > 0 &&
    v.outletName.length <= 200 &&
    typeof v.outletAddress === "string" &&
    v.outletAddress.length <= 500 &&
    optionalText(v.legalName ?? null) &&
    optionalText(v.npwpLast4 ?? null)
  );
}

export async function outletSnapshotFor(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<PosReceiptOutletSnapshot> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({
      outletName: outlets.name,
      outletAddress: outlets.address,
      legalName: legalEntities.name,
      npwpLast4: legalEntities.npwpLast4,
    })
    .from(outlets)
    .leftJoin(
      legalEntities,
      and(
        eq(legalEntities.tenantId, outlets.tenantId),
        eq(legalEntities.id, outlets.legalEntityId),
      ),
    )
    .where(
      and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId as OutletId)),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  return {
    outletName: row.outletName,
    outletAddress: row.outletAddress,
    legalName: row.legalName ?? null,
    npwpLast4: row.npwpLast4 ?? null,
  };
}

/**
 * Edge semantics from the first request (review K, legend-3yqy): the server
 * answers before `startEdgeRuntime` flips `edgeMode`, so the static
 * `EDGE_MODE` setting counts too. Otherwise an edge in its boot window would
 * act as the cloud and refuse its own device sales (RECEIPT_DEVICE_ON_EDGE).
 */
function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

/** S-K1 (legend-3yqy): the outlet has an active edge node in this database. */
async function outletHasActiveEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.status, "active"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * POS-06: next gapless number of the sale's device, inside the caller's order
 * transaction. An order that already has a receipt gets it back unchanged.
 */
export async function allocateReceipt(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    outletId: string;
    deviceId: string | null;
    at: Date;
  },
): Promise<PosReceipt> {
  const existing = await findReceiptForOrder(tx, context, input.orderId);
  if (existing) return existing;
  // An edge sale without a verified device cannot take a cloud number.
  if (input.deviceId === null && isEdgeProcess())
    throw new PosError("RECEIPT_DEVICE_REQUIRED");
  const tenantId = context.tenant.tenantId;
  const deviceKey = input.deviceId ?? input.outletId;
  const outletId = input.outletId as OutletId;
  // S-K1 (legend-3yqy): while an edge serves the outlet, its devices number
  // on the edge. A cloud number on the same device run would collide with
  // the edge's (two allocators, one counter each). Sales without a device
  // (sequence C) are the cloud's own and stay allowed.
  if (
    input.deviceId !== null &&
    !isEdgeProcess() &&
    (await outletHasActiveEdge(tx, tenantId, outletId))
  )
    throw new PosError("RECEIPT_DEVICE_ON_EDGE");
  const sequence = await ensureSequence(tx, tenantId, outletId, deviceKey);
  // The row lock taken here serialises every device sale on this sequence.
  // legend-zsdd (review K R1-A): a retired run never numbers, and in the cloud
  // a claim may bind the row between the read above and this UPDATE.
  const [advanced] = await tx
    .update(receiptSequences)
    .set({
      lastNumber: sql`${receiptSequences.lastNumber} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, sequence.id),
        isNull(receiptSequences.retiredAt),
        isEdgeProcess() ? undefined : isNull(receiptSequences.edgeNodeId),
      ),
    )
    .returning({
      prefix: receiptSequences.prefix,
      lastNumber: receiptSequences.lastNumber,
    });
  if (!advanced)
    throw new CoreError(
      "CONFLICT",
      "Nomor struk perangkat sedang dipindahkan; ulangi transaksi.",
    );
  const outletSnapshot = await outletSnapshotFor(tx, context, outletId);
  const [row] = await tx
    .insert(posReceipts)
    .values({
      tenantId,
      outletId,
      orderId: input.orderId,
      sequenceId: sequence.id,
      deviceId: deviceKey,
      number: formatReceiptNumber(advanced.prefix, advanced.lastNumber),
      sequenceNumber: advanced.lastNumber,
      status: "issued",
      issuedAt: input.at,
      outletSnapshot,
    })
    .returning();
  if (!row) throw new Error("Receipt insert returned no row");
  return toPosReceipt(row);
}

/** POS-06: flips the receipt to `voided`; the number stays on record. */
export async function voidReceiptForOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; reason: string; voidedBy: UserId; at: Date },
): Promise<PosReceipt | null> {
  const tenantId = context.tenant.tenantId;
  const [current] = await tx
    .select()
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(posReceipts.orderId, input.orderId),
      ),
    )
    .for("update");
  if (!current) return null;
  if (current.status === "voided") throw new PosError("RECEIPT_ALREADY_VOIDED");
  const [row] = await tx
    .update(posReceipts)
    .set({
      status: "voided",
      voidedAt: input.at,
      voidReason: voidReasonSchema.parse(input.reason),
      voidedBy: input.voidedBy,
      updatedAt: input.at,
    })
    .where(
      and(eq(posReceipts.tenantId, tenantId), eq(posReceipts.id, current.id)),
    )
    .returning();
  if (!row) throw new Error("Receipt void returned no row");
  return toPosReceipt(row);
}

/** Reprint counter, capped at the contract maximum (99). */
export async function markReceiptReprinted(
  tx: Tx,
  context: ScopedTenantContext,
  receiptId: string,
): Promise<PosReceipt> {
  const [row] = await tx
    .update(posReceipts)
    .set({
      reprintCount: sql`least(${posReceipts.reprintCount} + 1, 99)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(posReceipts.tenantId, context.tenant.tenantId),
        eq(posReceipts.id, receiptId),
      ),
    )
    .returning();
  if (!row) throw new CoreError("NOT_FOUND", "Struk tidak ditemukan.");
  return toPosReceipt(row);
}

/**
 * Lets a caller choose the prefix of a device before its first number. A
 * change after the first number would break POS-06, so it is refused.
 */
export async function provisionReceiptSequence(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; deviceId: string; prefix: string },
): Promise<ReceiptSequence> {
  const prefix = receiptPrefixSchema.parse(input.prefix);
  const tenantId = context.tenant.tenantId;
  const outletId = input.outletId as OutletId;
  // The outlet id key and prefix `C` belong to the cloud-owned sequence.
  if (input.deviceId === outletId || prefix === CLOUD_RECEIPT_PREFIX)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  await lockOutletSequences(tx, tenantId, outletId);
  const used = await prefixesOfOutlet(tx, tenantId, outletId);
  const owner = used.get(prefix);
  if (owner !== undefined && owner !== input.deviceId)
    throw new CoreError(
      "CONFLICT",
      "Prefiks struk ini sudah dipakai perangkat lain di outlet ini.",
    );
  const existing = await findSequenceRow(
    tx,
    tenantId,
    outletId,
    input.deviceId,
  );
  // legend-zsdd: a prefix of one of the device's retired runs never numbers again.
  if (owner !== undefined && existing?.prefix !== prefix)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  if (!existing)
    return toReceiptSequence(
      await insertSequence(tx, {
        tenantId,
        outletId,
        deviceId: input.deviceId,
        prefix,
      }),
    );
  if (existing.prefix === prefix) return toReceiptSequence(existing);
  if (existing.lastNumber > 0) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  // legend-zsdd: an edge-bound row may have numbers the cloud never saw
  // (its cloud lastNumber stays 0 until legend-ol6v), so its prefix is final.
  if (existing.edgeNodeId !== null)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  const [row] = await tx
    .update(receiptSequences)
    .set({ prefix, updatedAt: sql`now()` })
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, existing.id),
      ),
    )
    .returning();
  if (!row) throw new Error("Receipt sequence update returned no row");
  return toReceiptSequence(row);
}

// ---- Device sequences: cloud provisioning, edge replication (legend-3yqy) ----
//
// An edge never invents a prefix (ensureSequence), so the cloud provisions one
// for every device that can create a POS order, at enroll and (for devices
// enrolled earlier) when the edge pulls the device registry. The pull carries
// the outlet's device sequences; the edge inserts a missing one and never
// touches an existing one's counter. legend-zsdd: the pull first binds each
// sequence to the pulling edge database (claimDeviceReceiptSequencesForEdge)
// and lists only the ones bound to it; a run that may have numbered elsewhere
// is retired and replaced by a new prefix, on the cloud and on the edge.

/**
 * Device types that can create a POS order: the PIN terminals (§3 F6,
 * PIN_CAPABLE_DEVICE_TYPES). An order takes its receipt number from the device
 * that created it (pos_orders.device_id), so each of these needs a sequence.
 */
export const RECEIPT_DEVICE_TYPES = ["pos", "kds", "waiter_phone"] as const;

export function deviceTakesReceipts(type: string): boolean {
  return (RECEIPT_DEVICE_TYPES as readonly string[]).includes(type);
}

/**
 * Cloud: the device's sequence with the next free `P<n>` prefix of the outlet.
 * Idempotent: an existing row is returned unchanged.
 */
export async function provisionNextDeviceReceiptSequence(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; deviceId: string },
): Promise<ReceiptSequence> {
  const tenantId = context.tenant.tenantId;
  const outletId = input.outletId as OutletId;
  // The outlet id key belongs to the cloud-owned sequence `C`.
  if (input.deviceId === outletId)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  const existing = await findSequenceRow(
    tx,
    tenantId,
    outletId,
    input.deviceId,
  );
  if (existing) return toReceiptSequence(existing);
  if (isEdgeProcess()) throw new PosError("RECEIPT_SEQUENCE_NOT_PROVISIONED");
  await lockOutletSequences(tx, tenantId, outletId);
  const created = await findSequenceRow(tx, tenantId, outletId, input.deviceId);
  if (created) return toReceiptSequence(created);
  const used = await prefixesOfOutlet(tx, tenantId, outletId);
  return toReceiptSequence(
    await insertSequence(tx, {
      tenantId,
      outletId,
      deviceId: input.deviceId,
      prefix: nextFreePrefix(used),
    }),
  );
}

/**
 * Cloud: provisions a sequence for every active order-taking device of the
 * outlet that has none (devices enrolled before legend-3yqy). Revoked devices
 * get none. Returns how many were created.
 */
export async function backfillDeviceReceiptSequences(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const missing = await tx
    .select({ id: devices.id })
    .from(devices)
    .leftJoin(
      receiptSequences,
      and(
        eq(receiptSequences.tenantId, devices.tenantId),
        eq(receiptSequences.outletId, devices.outletId),
        eq(receiptSequences.deviceId, devices.id),
        // legend-zsdd: only a current row counts.
        isNull(receiptSequences.retiredAt),
      ),
    )
    .where(
      and(
        eq(devices.tenantId, tenantId),
        eq(devices.outletId, outletId as OutletId),
        eq(devices.status, "active"),
        isNull(devices.revokedAt),
        inArray(devices.type, [...RECEIPT_DEVICE_TYPES]),
        isNull(receiptSequences.id),
      ),
    )
    .orderBy(asc(devices.createdAt), asc(devices.id));
  for (const device of missing)
    await provisionNextDeviceReceiptSequence(tx, context, {
      outletId,
      deviceId: device.id,
    });
  return missing.length;
}

const sameBinding = (
  row: { edgeNodeId: string | null; edgeInstanceId: string | null },
  binding: DeviceReceiptSequenceBinding,
) =>
  row.edgeNodeId === binding.edgeNodeId &&
  row.edgeInstanceId === binding.edgeInstanceId;

export const RECEIPT_REGRESSION_ROTATIONS_MAX = 2;
export const RECEIPT_REGRESSION_WINDOW_HOURS = 24;
/**
 * legend-hfq3z: refused-run rotations (`claim_rotated`) per device and edge
 * database within RECEIPT_REGRESSION_WINDOW_HOURS before further refusals are throttled.
 */
export const RECEIPT_REFUSAL_ROTATIONS_MAX = 10;
/**
 * legend-hfq3z: a `prefix_used` heal retires at tau + this offset (an
 * `id_used` heal at tau), so the clone alarm can leave it out without a new
 * retire reason (follow-up legend-p7gb6 replaces both markers with a reason).
 */
const HEAL_PREFIX_USED_OFFSET_MS = 1;

/**
 * Cloud (legend-zsdd): hands the outlet's device sequences to the edge
 * database `edgeInstanceId` of node `edgeNodeId`. The caller has checked that
 * the node is the outlet's active primary. For each current sequence of an
 * active, not revoked, order-taking device:
 * - bound to this edge database: nothing, except the legend-yd0h8 check below;
 * - unbound at lastNumber 0: bound to it (claimed);
 * - otherwise (the cloud already numbered on it, or another node or another
 *   database of the node may have): retired (`claim_rotated`), and the device
 *   continues under the next free prefix, bound to this edge database at 0
 *   (rotated).
 *
 * legend-yd0h8: when `report` is given (the edge's local counter per run,
 * `prefix -> lastNumber`; absent = old edge, no check), every row bound to
 * exactly this edge database is compared with it. `reported` is the report's
 * entry for the prefix, 0 when the edge no longer holds the run; `high` is
 * max(edge_reported_number, lastNumber).
 * - reported >= high: normal; the high-water rises to `reported` if lower.
 * - reported < high: REGRESSION (restored or cloned database). The run is
 *   retired (`edge_regressed`) and the device continues under a new prefix
 *   bound to this database (regressed), unless the device already had
 *   RECEIPT_REGRESSION_ROTATIONS_MAX such rotations on this node in the last
 *   RECEIPT_REGRESSION_WINDOW_HOURS: then the row and its high-water stay
 *   (throttled).
 * `alert` is true when some device of the node has at least the maximum of
 * such rotations in the window (this pull's included), or when the report holds
 * a prefix of this binding retired as `edge_regressed` above its frozen
 * high-water with a newer token (a second live database: clone). Report
 * entries for unknown, other retired or foreign-bound prefixes are ignored.
 *
 * `reportedAt` is the cloud time the request reached the cloud (default now),
 * never the edge clock: a restored box may have a clock behind or ahead, which
 * would make every report stale or freeze the check. Token `tau` = reportedAt.
 * A row whose `edge_reported_at` is not before `tau` is STALE (a late arrival
 * of an older report) and is skipped (`stale`). When the high-water rises,
 * `edge_reported_at` becomes `tau`; a regression retire also stamps `tau`, so
 * a delayed report read before the restore cannot look newer than the retire.
 *
 * legend-hfq3z: `refusals` (id -> reason, the edge's report of replacement runs
 * it refused for a prefix or id clash on the previous pull; absent = old edge)
 * heals a device left without a run, only together with a `report` (an edge
 * that sends refusals always sends its runs; without a report an unreported
 * numbered run cannot be told from an empty one). A current row bound to
 * exactly this edge database whose id is reported, with lastNumber 0 and (on
 * `id_used`) edge_reported_number 0 and no number in `report`, is retired
 * (`claim_rotated`, no new reason; the heal stamps `edge_reported_at` with
 * `tau` and `retired_at` with `tau`, or `tau` + 1 ms on `prefix_used`, which
 * marks it) and
 * the device continues under the next free prefix bound to this database
 * (refusedRotated); the same request then lists the new run. That prefix is
 * above every `P<n>` in `report` and, on a prefix clash, above the refused
 * run's own (the edge holds prefixes the cloud lacks, e.g. after a cloud
 * restore), falling back to the first free one when it would be too long. On
 * a `prefix_used` refusal the report's number for the prefix is another local
 * run's and is ignored (also by the legend-yd0h8 check of a row that is not
 * healed); on `id_used` it is the run's own. A row with a stale token
 * (`edge_reported_at` not before `tau`) is not healed. A heal row is exactly:
 * `claim_rotated` with `retired_at - edge_reported_at` 0 or 1 ms and this
 * binding; a
 * normal claim rotation by another database of the node keeps the binding of
 * the retired row but has retired_at = now() and an older or NULL
 * edge_reported_at, so binding alone does not identify a heal. The throttle is
 * RECEIPT_REFUSAL_ROTATIONS_MAX heal rows of the device in the window. Beyond
 * it the row is left to the normal handling (refusedThrottled, which also sets
 * `alert`: a device is left without a run).
 * Reported ids that are retired, unknown, of another tenant or binding, or
 * that hold numbers are ignored; repeating a report is idempotent (the new run
 * has another id). The clone alarm also counts `id_used` heal rows: a later
 * report above the frozen high-water with a newer token means another live
 * database numbered that run.
 *
 * Limits: sales between a restore and the first successful pull still reuse
 * numbers already issued; and a clone gets an alarm, not prevention (both
 * databases receive the new prefix).
 */
export async function claimDeviceReceiptSequencesForEdge(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    report?: ReceiptRunReport;
    refusals?: ReceiptRunRefusalReport;
    reportedAt?: Date;
  } & DeviceReceiptSequenceBinding,
): Promise<{
  claimed: number;
  rotated: number;
  regressed: number;
  throttled: number;
  refusedRotated: number;
  refusedThrottled: number;
  stale: number;
  alert: boolean;
}> {
  if (isEdgeProcess())
    throw new Error("Receipt sequences are claimed on the cloud only");
  const tenantId = context.tenant.tenantId;
  const outletId = input.outletId as OutletId;
  const binding: DeviceReceiptSequenceBinding = {
    edgeNodeId: input.edgeNodeId,
    edgeInstanceId: input.edgeInstanceId,
  };
  await lockOutletSequences(tx, tenantId, outletId);
  // legend-yd0h8: report token = cloud arrival time of the request.
  const tau = input.reportedAt ?? new Date();
  // legend-yd0h8: regression rotations per device of this node in the window.
  const regressions = new Map<string, number>();
  let cloneSeen = false;
  // legend-hfq3z: refused-run rotations per device of this node in the window.
  const refusalRotations = new Map<string, number>();
  const refusals = input.refusals;
  if (
    input.report !== undefined &&
    refusals !== undefined &&
    refusals.size > 0
  ) {
    // A heal row is `claim_rotated` with `retired_at - edge_reported_at` 0
    // (id_used) or 1 ms (prefix_used) and this exact binding. The binding alone is
    // not enough: a normal claim rotation by another database of the node
    // retires this binding's row too (the row keeps its binding), but with
    // retired_at = now() and an older or NULL edge_reported_at.
    const recent = await tx
      .select({
        deviceId: receiptSequences.deviceId,
        count: sql<number>`count(*)::int`,
      })
      .from(receiptSequences)
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.edgeNodeId, binding.edgeNodeId),
          eq(receiptSequences.edgeInstanceId, binding.edgeInstanceId),
          eq(receiptSequences.retiredReason, "claim_rotated"),
          // Both heal markers (id_used: +0, prefix_used: +1 ms).
          sql`${receiptSequences.retiredAt} - ${receiptSequences.edgeReportedAt} IN (interval '0', make_interval(secs => ${HEAL_PREFIX_USED_OFFSET_MS / 1000}))`,
          sql`${receiptSequences.retiredAt} > now() - make_interval(hours => ${RECEIPT_REGRESSION_WINDOW_HOURS})`,
        ),
      )
      .groupBy(receiptSequences.deviceId);
    for (const row of recent) refusalRotations.set(row.deviceId, row.count);
  }
  if (input.report !== undefined) {
    const recent = await tx
      .select({
        deviceId: receiptSequences.deviceId,
        count: sql<number>`count(*)::int`,
      })
      .from(receiptSequences)
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.edgeNodeId, binding.edgeNodeId),
          eq(receiptSequences.retiredReason, "edge_regressed"),
          sql`${receiptSequences.retiredAt} > now() - make_interval(hours => ${RECEIPT_REGRESSION_WINDOW_HOURS})`,
        ),
      )
      .groupBy(receiptSequences.deviceId);
    for (const row of recent) regressions.set(row.deviceId, row.count);
    // A report of a prefix retired by a regression, above its frozen
    // high-water and newer than it, means a second live database.
    const retired = await tx
      .select({
        prefix: receiptSequences.prefix,
        edgeReportedNumber: receiptSequences.edgeReportedNumber,
        edgeReportedAt: receiptSequences.edgeReportedAt,
      })
      .from(receiptSequences)
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.edgeNodeId, binding.edgeNodeId),
          eq(receiptSequences.edgeInstanceId, binding.edgeInstanceId),
          // An id_used heal retirement (legend-hfq3z) is `claim_rotated` of
          // this exact binding with retired_at = edge_reported_at (both tau);
          // a normal claim rotation keeps the binding too but does not match.
          // A prefix_used heal (retired_at = tau + 1 ms) is left out: the edge
          // keeps reporting that prefix for its other local run by definition.
          or(
            eq(receiptSequences.retiredReason, "edge_regressed"),
            and(
              eq(receiptSequences.retiredReason, "claim_rotated"),
              sql`${receiptSequences.retiredAt} = ${receiptSequences.edgeReportedAt}`,
            ),
          ),
          sql`${receiptSequences.retiredAt} > now() - make_interval(hours => ${RECEIPT_REGRESSION_WINDOW_HOURS})`,
        ),
      );
    cloneSeen = retired.some(
      (row) =>
        (input.report?.get(row.prefix) ?? 0) > row.edgeReportedNumber &&
        (row.edgeReportedAt === null || tau > row.edgeReportedAt),
    );
  }
  const current = await tx
    .select({ sequence: receiptSequences })
    .from(receiptSequences)
    .innerJoin(
      devices,
      and(
        eq(devices.tenantId, receiptSequences.tenantId),
        eq(devices.outletId, receiptSequences.outletId),
        eq(devices.id, receiptSequences.deviceId),
      ),
    )
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId),
        isNull(receiptSequences.retiredAt),
        sql`${receiptSequences.deviceId} <> ${receiptSequences.outletId}`,
        eq(devices.status, "active"),
        isNull(devices.revokedAt),
        inArray(devices.type, [...RECEIPT_DEVICE_TYPES]),
      ),
    )
    .orderBy(asc(receiptSequences.createdAt), asc(receiptSequences.id))
    // A cloud sale on one of these rows waits until the claim commits.
    .for("update", { of: receiptSequences });
  let claimed = 0;
  let rotated = 0;
  let regressed = 0;
  let throttled = 0;
  let refusedRotated = 0;
  let refusedThrottled = 0;
  let stale = 0;
  let used: Map<string, string> | undefined;
  for (const { sequence } of current) {
    if (sameBinding(sequence, binding)) {
      // legend-hfq3z: the edge refused this run (prefix or id clash) and
      // holds no number of it: replace it, the device has no usable run.
      // Only with a report: without one the cloud cannot tell an unreported
      // numbered run from an empty one. On a `prefix_used` refusal the
      // report's number for this prefix belongs to ANOTHER local run (the
      // clashing one), so it is ignored; on `id_used` it is this run's own.
      // A `prefix_used` row may carry an edge_reported_number raised from
      // that other run before legend-hfq3z (the old legend-yd0h8 path); the
      // edge holds no number of this id (the prefix check runs first), and a
      // fresh prefix cannot reuse a number, so that number does not block it.
      const refusal = refusals?.get(sequence.id);
      if (input.report !== undefined && refusal !== undefined) {
        const healable =
          sequence.lastNumber === 0 &&
          (refusal === "prefix_used" ||
            (sequence.edgeReportedNumber === 0 &&
              (input.report.get(sequence.prefix) ?? 0) === 0)) &&
          // A stale token (defensive: a heal-eligible row normally has NULL).
          !(sequence.edgeReportedAt !== null && tau <= sequence.edgeReportedAt);
        if (healable) {
          const done = refusalRotations.get(sequence.deviceId) ?? 0;
          if (done >= RECEIPT_REFUSAL_ROTATIONS_MAX) {
            refusedThrottled += 1;
          } else {
            // The heal marker: edge_reported_at = tau and retired_at = tau
            // (id_used) or tau + 1 ms (prefix_used, see HEAL_PREFIX_USED_OFFSET_MS).
            await retireSequence(
              tx,
              tenantId,
              sequence.id,
              "claim_rotated",
              tau,
              refusal === "prefix_used"
                ? new Date(tau.getTime() + HEAL_PREFIX_USED_OFFSET_MS)
                : tau,
            );
            used ??= await prefixesOfOutlet(tx, tenantId, outletId);
            // A clash means the edge holds prefixes the cloud lacks: step past
            // every prefix it reports (and past the refused one on a prefix
            // clash) instead of burning the throttle one prefix at a time.
            let floor = 0;
            for (const reportedPrefix of input.report.keys())
              floor = Math.max(floor, prefixNumber(reportedPrefix));
            if (refusal === "prefix_used")
              floor = Math.max(floor, prefixNumber(sequence.prefix));
            const prefix = nextFreePrefixAbove(used, floor);
            await insertSequence(tx, {
              tenantId,
              outletId,
              deviceId: sequence.deviceId,
              prefix,
              binding,
            });
            used.set(prefix, sequence.deviceId);
            refusalRotations.set(sequence.deviceId, done + 1);
            refusedRotated += 1;
            continue;
          }
        }
        // Not healed (throttled or not eligible): the report's number for a
        // `prefix_used` run is another run's, so it must neither raise this
        // run's high-water nor rotate it as regressed.
        if (refusal === "prefix_used") continue;
      }
      if (input.report === undefined) continue;
      if (sequence.edgeReportedAt !== null && tau <= sequence.edgeReportedAt) {
        stale += 1;
        continue;
      }
      const reported = input.report.get(sequence.prefix) ?? 0;
      const high = Math.max(sequence.edgeReportedNumber, sequence.lastNumber);
      if (reported >= high) {
        if (reported > sequence.edgeReportedNumber)
          await tx
            .update(receiptSequences)
            .set({
              edgeReportedNumber: reported,
              edgeReportedAt: tau,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(receiptSequences.tenantId, tenantId),
                eq(receiptSequences.id, sequence.id),
                isNull(receiptSequences.retiredAt),
                sql`${receiptSequences.edgeReportedNumber} < ${reported}`,
              ),
            );
        continue;
      }
      // legend-yd0h8: the edge is behind what it reported or issued before.
      const done = regressions.get(sequence.deviceId) ?? 0;
      if (done >= RECEIPT_REGRESSION_ROTATIONS_MAX) {
        throttled += 1;
        continue;
      }
      await retireSequence(tx, tenantId, sequence.id, "edge_regressed", tau);
      used ??= await prefixesOfOutlet(tx, tenantId, outletId);
      const prefix = nextFreePrefix(used);
      await insertSequence(tx, {
        tenantId,
        outletId,
        deviceId: sequence.deviceId,
        prefix,
        binding,
      });
      used.set(prefix, sequence.deviceId);
      regressions.set(sequence.deviceId, done + 1);
      regressed += 1;
      continue;
    }
    if (sequence.edgeNodeId === null && sequence.lastNumber === 0) {
      const [bound] = await tx
        .update(receiptSequences)
        .set({
          edgeNodeId: binding.edgeNodeId,
          edgeInstanceId: binding.edgeInstanceId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(receiptSequences.tenantId, tenantId),
            eq(receiptSequences.id, sequence.id),
            isNull(receiptSequences.retiredAt),
            isNull(receiptSequences.edgeNodeId),
            eq(receiptSequences.lastNumber, 0),
          ),
        )
        .returning({ id: receiptSequences.id });
      if (bound) {
        claimed += 1;
        continue;
      }
    }
    await retireSequence(tx, tenantId, sequence.id, "claim_rotated");
    used ??= await prefixesOfOutlet(tx, tenantId, outletId);
    const prefix = nextFreePrefix(used);
    await insertSequence(tx, {
      tenantId,
      outletId,
      deviceId: sequence.deviceId,
      prefix,
      binding,
    });
    used.set(prefix, sequence.deviceId);
    rotated += 1;
  }
  const alert =
    (input.report !== undefined &&
      (cloneSeen ||
        [...regressions.values()].some(
          (count) => count >= RECEIPT_REGRESSION_ROTATIONS_MAX,
        ))) ||
    refusedThrottled > 0;
  return {
    claimed,
    rotated,
    regressed,
    throttled,
    refusedRotated,
    refusedThrottled,
    stale,
    alert,
  };
}

/**
 * Edge (legend-yd0h8): the counter of every current local device run,
 * `prefix -> lastNumber`, any binding (not the outlet-owned run). Sent with the
 * device-records pull so the cloud can tell a restored or cloned database.
 */
export async function localReceiptRunReport(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<Map<string, number>> {
  if (!isEdgeProcess())
    throw new Error("The receipt run report is built on the edge only");
  const rows = await tx
    .select({
      prefix: receiptSequences.prefix,
      lastNumber: receiptSequences.lastNumber,
    })
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, context.tenant.tenantId),
        eq(receiptSequences.outletId, outletId as OutletId),
        isNull(receiptSequences.retiredAt),
        sql`${receiptSequences.deviceId} <> ${receiptSequences.outletId}`,
      ),
    );
  return new Map(rows.map((row) => [row.prefix, row.lastNumber]));
}

/**
 * Cloud: the outlet's current device sequences (not the cloud-owned `C`) bound
 * to exactly this edge database, for the edge pull (legend-zsdd).
 */
export async function listDeviceReceiptSequences(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  binding: DeviceReceiptSequenceBinding,
): Promise<DeviceReceiptSequenceSync[]> {
  const rows = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, context.tenant.tenantId),
        eq(receiptSequences.outletId, outletId as OutletId),
        sql`${receiptSequences.deviceId} <> ${receiptSequences.outletId}`,
        isNull(receiptSequences.retiredAt),
        eq(receiptSequences.edgeNodeId, binding.edgeNodeId),
        eq(receiptSequences.edgeInstanceId, binding.edgeInstanceId),
      ),
    )
    .orderBy(asc(receiptSequences.createdAt), asc(receiptSequences.id));
  return rows.map((row) => ({
    id: row.id,
    outletId: row.outletId,
    deviceId: row.deviceId,
    prefix: row.prefix,
    lastNumber: row.lastNumber,
    edgeNodeId: binding.edgeNodeId,
    edgeInstanceId: binding.edgeInstanceId,
  }));
}

/**
 * Edge: one pulled device sequence, with this edge database's own binding
 * `own` (node id, instance id; legend-zsdd). Nothing is written when refused.
 * - refused: the pulled sequence is bound to another node or database, or it
 *   is the outlet-owned key / prefix `C`.
 * - kept: the device's current row here has the same id and prefix;
 *   untouched (its counter is ahead), except a NULL local binding is set to
 *   `own`.
 * - replaced: the device's current row here has another id or prefix (the
 *   cloud rotated the run). The local row is retired and the pulled one is
 *   inserted at 0 bound to `own`. Refused if the pulled prefix or id already
 *   exists here on another row, or the pulled run is already at L > 0 (same
 *   3yqy backstop as `inserted`; review K R1-A); the local row stays current.
 *   A prefix or id clash returns `refused_prefix_used` / `refused_id_used`
 *   (legend-hfq3z) so the edge can report it to the cloud on the next pull;
 *   both count as refused.
 * - inserted: no current row for the device; created with the cloud's id and
 *   prefix at 0 bound to `own`. Refused if the prefix or id is already used
 *   here, or (S-K1, legend-3yqy backstop) the cloud run is already at L > 0:
 *   the edge holds none of receipts 1..L, so the gap check would refuse Tutup
 *   Hari forever. The clash outcomes are as for `replaced`.
 */
export async function applyCloudDeviceReceiptSequence(
  tx: Tx,
  context: ScopedTenantContext,
  sequence: DeviceReceiptSequenceSync,
  own: DeviceReceiptSequenceBinding,
): Promise<
  | "inserted"
  | "kept"
  | "replaced"
  | "refused"
  | "refused_prefix_used"
  | "refused_id_used"
> {
  const tenantId = context.tenant.tenantId;
  const outletId = sequence.outletId as OutletId;
  if (!sameBinding(sequence, own)) return "refused";
  if (
    sequence.deviceId === outletId ||
    sequence.prefix === CLOUD_RECEIPT_PREFIX
  )
    return "refused";
  await lockOutletSequences(tx, tenantId, outletId);
  const existing = await findSequenceRow(
    tx,
    tenantId,
    outletId,
    sequence.deviceId,
  );
  if (
    existing &&
    existing.id === sequence.id &&
    existing.prefix === sequence.prefix
  ) {
    if (existing.edgeNodeId === null) {
      await tx
        .update(receiptSequences)
        .set({
          edgeNodeId: own.edgeNodeId,
          edgeInstanceId: own.edgeInstanceId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(receiptSequences.tenantId, tenantId),
            eq(receiptSequences.id, existing.id),
            isNull(receiptSequences.retiredAt),
            isNull(receiptSequences.edgeNodeId),
          ),
        );
      return "kept";
    }
    // A local row bound elsewhere cannot be rebound (trigger); leave it.
    return sameBinding(existing, own) ? "kept" : "refused";
  }
  // Backstop for both `inserted` and `replaced` (review K R1-A).
  if (sequence.lastNumber > 0) return "refused";
  const used = await prefixesOfOutlet(tx, tenantId, outletId);
  if (used.has(sequence.prefix)) return "refused_prefix_used";
  const [sameId] = await tx
    .select({ id: receiptSequences.id })
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, sequence.id),
      ),
    );
  if (sameId) return "refused_id_used";
  // legend-hfq3z: the id is the primary key of the whole table, and a row
  // this outlet-scoped read cannot see (RLS) still clashes on insert. The
  // retire and insert run in a savepoint: such a clash undoes both (the local
  // row stays current, as for any refusal) and is reported like `sameId`,
  // instead of aborting the whole list.
  try {
    await tx.transaction(async (savepoint) => {
      if (existing)
        await retireSequence(savepoint, tenantId, existing.id, "edge_replaced");
      await savepoint.insert(receiptSequences).values({
        id: sequence.id,
        tenantId,
        outletId,
        deviceId: sequence.deviceId,
        prefix: sequence.prefix,
        lastNumber: 0,
        edgeNodeId: own.edgeNodeId,
        edgeInstanceId: own.edgeInstanceId,
      });
    });
  } catch (error) {
    const clash = receiptSequenceClashOf(error);
    if (clash === "id") return "refused_id_used";
    if (clash === "prefix") return "refused_prefix_used";
    throw error;
  }
  return existing ? "replaced" : "inserted";
}

/**
 * legend-hfq3z: which unique key of `receipt_sequences` a PostgreSQL error
 * (directly or in drizzle's cause chain) violated: the id (primary key or
 * tenant + id) or the outlet prefix; null for anything else.
 */
function receiptSequenceClashOf(
  error: unknown,
  depth = 0,
): "id" | "prefix" | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505") {
    if (
      candidate.constraint === "receipt_sequences_pkey" ||
      candidate.constraint === "receipt_sequences_tenant_id_id_key"
    )
      return "id";
    if (candidate.constraint === "receipt_sequences_prefix_key")
      return "prefix";
    return null;
  }
  return receiptSequenceClashOf(candidate.cause, depth + 1);
}

/**
 * Edge (legend-sduiq): after a pull page's sequences are applied, retires this
 * database's current device runs that the cloud no longer lists. The cloud's
 * list is complete: every current device run of the outlet bound to exactly
 * `own` (the claim of the same request binds or rotates all of them first).
 * A local run usable here (bound to `own`, or unbound 3yqy-era) missing from
 * it was retired by the cloud, typically rotated by legend-yd0h8 while the
 * replacement was refused here (prefix or id clash, run already advanced);
 * without this the device would keep numbering a run the cloud retired. The
 * device then numbers nothing (RECEIPT_SEQUENCE_NOT_PROVISIONED; fail closed)
 * until a pull delivers a run it accepts. For an advanced replacement
 * (L > 0) the next claim rotates it (absent from the report = 0 < high-water).
 * For a prefix or id clash the replacement stays at 0 and is refused here
 * (edge status `receiptSequencesRefused` > 0); the edge reports the refusal on
 * the next pull and the cloud claim rotates it (legend-hfq3z).
 * Callers pass the ids of the page's entries bound to `own`, from a list that
 * passed its page checks (a refused list never gets here); no such id (empty
 * list, or a node id mismatch) is ambiguous and never retires anything. Rows
 * bound to another binding already cannot number here and are left alone.
 * Returns the count.
 */
export async function retireUnlistedDeviceReceiptSequences(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  listedIds: readonly string[],
  own: DeviceReceiptSequenceBinding,
): Promise<number> {
  if (listedIds.length === 0) return 0;
  const tenantId = context.tenant.tenantId;
  const outlet = outletId as OutletId;
  await lockOutletSequences(tx, tenantId, outlet);
  const rows = await tx
    .select({ id: receiptSequences.id })
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outlet),
        sql`${receiptSequences.deviceId} <> ${receiptSequences.outletId}`,
        isNull(receiptSequences.retiredAt),
        or(
          isNull(receiptSequences.edgeNodeId),
          and(
            eq(receiptSequences.edgeNodeId, own.edgeNodeId),
            eq(receiptSequences.edgeInstanceId, own.edgeInstanceId),
          ),
        ),
        notInArray(receiptSequences.id, [...listedIds]),
      ),
    );
  for (const row of rows)
    await retireSequence(tx, tenantId, row.id, "edge_replaced");
  return rows.length;
}

/** Void columns of a merged receipt, taken from the cloud void row. */
function voidFieldsOf(
  receipt: PosReceipt,
  voidRows: ReadonlyMap<string, typeof posOrderVoids.$inferSelect>,
): {
  voidedAt: Date | null;
  voidReason: string | null;
  voidedBy: UserId | null;
} {
  if (receipt.status !== "voided")
    return { voidedAt: null, voidReason: null, voidedBy: null };
  const row = voidRows.get(receipt.orderId);
  if (!row) throw new PosError("RECEIPT_VOID_UNMATCHED");
  return {
    voidedAt: row.voidedAt,
    voidReason: voidReasonSchema.parse(row.reason),
    voidedBy: userIdSchema.parse(row.requestedBy),
  };
}

/**
 * Cloud merge of an offline device run. The device's run is authoritative for
 * its ordinals. Incoming receipts missing in the cloud are inserted (above or
 * below the cloud `lastNumber`: late and reversed batches are fine), an
 * ordinal already present must be the very same receipt (replay is a no-op)
 * and a receipt marked voided by the device is voided here only when the cloud
 * holds the matching `pos_order_voids` row (the approval path); the void
 * time, reason and actor come from that row, never from the device (else
 * RECEIPT_VOID_UNMATCHED). The cloud `lastNumber`
 * moves to max(cloud, device) only when every ordinal 1..newLast exists after
 * the batch; otherwise nothing is written and RECEIPT_SEQUENCE_GAP lists the
 * missing ordinals (the device resends the full range). A device cannot use
 * the cloud-owned sequence (outlet id key, prefix `C`) and can only reference
 * completed orders of its own outlet that carry its own device id, and only
 * under the prefix the cloud gave the device (else
 * RECEIPT_SEQUENCE_NOT_PROVISIONED / RECEIPT_PREFIX_MISMATCH).
 */
export async function mergeDeviceReceiptRun(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    sequence: {
      outletId: string;
      deviceId: string;
      prefix: string;
      lastNumber: number;
    };
    receipts: (PosReceipt & { outletSnapshot?: PosReceiptOutletSnapshot })[];
    /**
     * legend-n1fzg: ordinals the caller accounted for without a receipt (the
     * receipt of an order the cloud permanently refused, skipped by the edge
     * applier and recorded as a conflict). They count as present in the
     * completeness walk only; no receipt is written for them.
     */
    skippedOrdinals?: ReadonlySet<number>;
  },
): Promise<{ sequence: ReceiptSequence; inserted: number }> {
  const tenantId = context.tenant.tenantId;
  const { deviceId, prefix } = input.sequence;
  const outletId = input.sequence.outletId as OutletId;
  // The outlet id is the key of the cloud-owned sequence; a device never owns it.
  if (deviceId === outletId || prefix === CLOUD_RECEIPT_PREFIX)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  // The sync boundary validates too; the service still refuses a last number
  // that is not a receipt ordinal so the completeness walk stays bounded.
  const lastNumber = input.sequence.lastNumber;
  if (
    !Number.isInteger(lastNumber) ||
    lastNumber < 0 ||
    lastNumber > RECEIPT_MAX_ORDINAL
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Nomor terakhir perangkat tidak valid.",
    );
  for (const receipt of input.receipts)
    if (receipt.outletSnapshot && !isOutletSnapshot(receipt.outletSnapshot))
      throw new CoreError(
        "VALIDATION_ERROR",
        "Kepala struk dari perangkat tidak valid.",
      );
  // A device may only claim a void with well-formed fields; the values that
  // are written come from the cloud void row below.
  for (const receipt of input.receipts)
    if (
      receipt.status === "voided" &&
      !(
        voidReasonSchema.safeParse(receipt.voidReason).success &&
        userIdSchema.safeParse(receipt.voidedBy).success &&
        typeof receipt.voidedAt === "string" &&
        !Number.isNaN(new Date(receipt.voidedAt).getTime())
      )
    )
      throw new CoreError(
        "VALIDATION_ERROR",
        "Data void struk dari perangkat tidak valid.",
      );
  await lockOutletSequences(tx, tenantId, outletId);
  // The device's prefix comes only from the cloud (provisionReceiptSequence or
  // a cloud sale of the device); a run under a prefix the cloud never gave
  // out is refused, so two devices can never pick the same one offline.
  // legend-zsdd (legend-ol6v): any run of the device, retired ones included,
  // so a late run of a replaced sequence still merges.
  // legend-refx7: the rows are locked FOR UPDATE here, before any other read,
  // the same lock the write-off takes first (pos-receipt-writeoff.service.ts).
  // A write-off in flight finishes first, so the write-off read after the
  // inserts below is final; ordered by id so two merges never lock in
  // opposite order.
  const deviceRows = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId),
        eq(receiptSequences.deviceId, deviceId),
      ),
    )
    .orderBy(asc(receiptSequences.id))
    .for("update");
  if (deviceRows.length === 0)
    throw new PosError("RECEIPT_SEQUENCE_NOT_PROVISIONED");
  const cloudRow = deviceRows.find((row) => row.prefix === prefix);
  if (!cloudRow) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  const cloudLast = cloudRow.lastNumber;

  // Validate the whole batch before anything is written.
  const ordinals = new Set<number>();
  const batchOrderIds = new Set<string>();
  for (const receipt of input.receipts) {
    if (
      receipt.tenantId !== tenantId ||
      receipt.outletId !== outletId ||
      receipt.deviceId !== deviceId
    )
      throw new PosError("RECEIPT_PREFIX_MISMATCH");
    assertReceiptMatchesSequence(
      { prefix, lastNumber: input.sequence.lastNumber },
      receipt,
    );
    // Two receipts for one ordinal or one order disagree with each other.
    if (
      ordinals.has(receipt.sequenceNumber) ||
      batchOrderIds.has(receipt.orderId)
    )
      throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
    ordinals.add(receipt.sequenceNumber);
    batchOrderIds.add(receipt.orderId);
  }
  // A void correction leaves the order `completed` and writes a
  // `pos_order_voids` row (voidPosOrderCorrection); that row is the proof.
  const voidRows = new Map<string, typeof posOrderVoids.$inferSelect>();
  if (input.receipts.length > 0) {
    const orderIds = [...batchOrderIds];
    const orderRows = await tx
      .select({ orderId: posOrders.orderId, status: orders.status })
      .from(posOrders)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, posOrders.tenantId),
          eq(orders.id, posOrders.orderId),
        ),
      )
      .where(
        and(
          eq(posOrders.tenantId, tenantId),
          eq(posOrders.outletId, outletId),
          eq(posOrders.deviceId, deviceId),
          // A voided-before-payment order never had a receipt.
          eq(orders.status, "completed"),
          inArray(posOrders.orderId, orderIds),
        ),
      );
    const known = new Map<string, string>(
      orderRows.map((row) => [row.orderId, row.status]),
    );
    for (const orderId of orderIds)
      if (!known.has(orderId)) throw new PosError("RECEIPT_PREFIX_MISMATCH");
    const voidedIds = input.receipts
      .filter((receipt) => receipt.status === "voided")
      .map((receipt) => receipt.orderId);
    if (voidedIds.length > 0) {
      const found = await tx
        .select()
        .from(posOrderVoids)
        .where(
          and(
            eq(posOrderVoids.tenantId, tenantId),
            eq(posOrderVoids.outletId, outletId),
            inArray(posOrderVoids.orderId, voidedIds),
          ),
        );
      for (const row of found) voidRows.set(row.orderId, row);
      for (const orderId of voidedIds)
        if (!voidRows.has(orderId))
          throw new PosError("RECEIPT_VOID_UNMATCHED");
    }
  }

  // Compare the batch with what the cloud already holds.
  const byOrdinal = new Map<number, ReceiptRow>();
  const cloudOrdinals = new Set<number>();
  const held = await tx
    .select()
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(posReceipts.sequenceId, cloudRow.id),
      ),
    );
  for (const row of held) {
    byOrdinal.set(row.sequenceNumber, row);
    cloudOrdinals.add(row.sequenceNumber);
  }
  const byOrder = new Map<string, ReceiptRow>();
  if (input.receipts.length > 0) {
    const rows = await tx
      .select()
      .from(posReceipts)
      .where(
        and(
          eq(posReceipts.tenantId, tenantId),
          inArray(posReceipts.orderId, [...batchOrderIds]),
        ),
      );
    for (const row of rows) byOrder.set(row.orderId, row);
  }
  const toInsert: typeof input.receipts = [];
  const toVoid: { existing: ReceiptRow; receipt: PosReceipt }[] = [];
  for (const receipt of input.receipts) {
    const existing = byOrdinal.get(receipt.sequenceNumber);
    const sameOrder = byOrder.get(receipt.orderId);
    if (!existing) {
      // The order already has a receipt elsewhere: the device disagrees.
      if (sameOrder) throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
      toInsert.push(receipt);
      continue;
    }
    if (
      existing.orderId !== receipt.orderId ||
      existing.number !== receipt.number
    )
      throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
    if (receipt.status === "voided" && existing.status === "issued")
      toVoid.push({ existing, receipt });
  }

  // Completeness: the sequence advances only over a run with no hole. A stale
  // batch (device.last <= cloud.last) never moves it and is never refused.
  // An advancing merge needs a real receipt (cloud or batch) for every number
  // 1..newLast. Write-offs are deliberately not consulted here: a written-off
  // number never lets a device run advance (legend-0hzqw, legend-xlvvl).
  const newLast = Math.max(cloudLast, input.sequence.lastNumber);
  if (input.sequence.lastNumber > cloudLast) {
    // Stops after 21 holes: the walk is bounded by the rows present plus 21.
    const missing: number[] = [];
    for (let n = 1; n <= newLast && missing.length <= 20; n += 1)
      if (
        !cloudOrdinals.has(n) &&
        !ordinals.has(n) &&
        !input.skippedOrdinals?.has(n)
      )
        missing.push(n);
    if (missing.length > 0) {
      const shown = missing.slice(0, 20).join(", ");
      const more = missing.length > 20 ? " dan lainnya" : "";
      throw new PosError(
        "RECEIPT_SEQUENCE_GAP",
        `Ada nomor struk yang hilang pada perangkat ini: ${shown}${more}.`,
      );
    }
  }

  // Writes: sequence first (the retained trigger needs sequence_number <=
  // last_number), then receipts, all in the caller's transaction.
  let sequenceRow = cloudRow;
  if (newLast !== sequenceRow.lastNumber) {
    // legend-ol6v: advancing a live edge-owned run stamps the cloud arrival
    // time (app clock, read after the outlet sequence lock), so a pull report
    // sent before this merge is stale. GREATEST because trigger 0154 refuses a
    // backward edge_reported_at; a retired run's stamp is never changed.
    const stampReported =
      newLast > sequenceRow.lastNumber &&
      sequenceRow.retiredAt === null &&
      sequenceRow.edgeNodeId !== null;
    const stamp = new Date();
    const [row] = await tx
      .update(receiptSequences)
      .set({
        lastNumber: newLast,
        updatedAt: sql`now()`,
        ...(stampReported
          ? {
              edgeReportedAt: sql`GREATEST(${receiptSequences.edgeReportedAt}, ${stamp.toISOString()}::timestamptz)`,
            }
          : {}),
      })
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.id, sequenceRow.id),
        ),
      )
      .returning();
    if (!row) throw new Error("Receipt sequence update returned no row");
    sequenceRow = row;
  }

  let fallbackSnapshot: PosReceiptOutletSnapshot | undefined;
  for (const receipt of toInsert) {
    // The device's own copy is the header printed at the sale. Without one,
    // the outlet at merge time is the closest record (a rename between the
    // offline sale and this sync is not seen; bead legend-zy43).
    let snapshot: PosReceiptOutletSnapshot | undefined = receipt.outletSnapshot
      ? {
          outletName: receipt.outletSnapshot.outletName,
          outletAddress: receipt.outletSnapshot.outletAddress,
          legalName: receipt.outletSnapshot.legalName ?? null,
          npwpLast4: receipt.outletSnapshot.npwpLast4 ?? null,
        }
      : undefined;
    if (!snapshot) {
      fallbackSnapshot ??= await outletSnapshotFor(tx, context, outletId);
      snapshot = fallbackSnapshot;
    }
    await tx.insert(posReceipts).values({
      id: receipt.id,
      tenantId,
      outletId,
      orderId: receipt.orderId,
      sequenceId: sequenceRow.id,
      deviceId,
      number: receipt.number,
      sequenceNumber: receipt.sequenceNumber,
      status: receipt.status,
      issuedAt: new Date(receipt.issuedAt),
      ...voidFieldsOf(receipt, voidRows),
      reprintCount: receipt.reprintCount,
      outletSnapshot: snapshot,
    });
  }
  // legend-refx7: a stored receipt whose number was written off is kept; the
  // owner is told (audit + alarm).
  await reportReceiptsArrivedAfterWriteoff(tx, context, {
    outletId,
    sequenceId: sequenceRow.id,
    prefix,
    stored: toInsert,
    now: new Date(),
  });
  for (const { existing, receipt } of toVoid)
    await tx
      .update(posReceipts)
      .set({
        status: "voided",
        ...voidFieldsOf(receipt, voidRows),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(posReceipts.tenantId, tenantId),
          eq(posReceipts.id, existing.id),
          // A cashier void between the read and this write wins; no-op then.
          eq(posReceipts.status, "issued"),
        ),
      );
  return {
    sequence: toReceiptSequence(sequenceRow),
    inserted: toInsert.length,
  };
}

/** Sequences of the outlet that issued a number with no receipt row (POS-06). */
export async function receiptGapsForOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<
  {
    sequenceId: string;
    deviceId: string;
    prefix: string;
    lastNumber: number;
    missing: number[];
  }[]
> {
  const tenantId = context.tenant.tenantId;
  const sequences = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId as OutletId),
      ),
    )
    .orderBy(asc(receiptSequences.prefix));
  if (sequences.length === 0) return [];
  // legend-0hzqw, legend-xlvvl: a written-off number counts as present. Receipts
  // and write-offs are read in ONE statement (one READ COMMITTED snapshot), so
  // a late receipt cannot land between two reads and look like a gap. The
  // union is not deduplicated (UNION ALL); `receiptGaps` treats it as a set.
  const sequenceIds = sequences.map((sequence) => sequence.id);
  const present = await unionAll(
    tx
      .select({
        sequenceId: posReceipts.sequenceId,
        sequenceNumber: posReceipts.sequenceNumber,
      })
      .from(posReceipts)
      .where(
        and(
          eq(posReceipts.tenantId, tenantId),
          inArray(posReceipts.sequenceId, sequenceIds),
        ),
      ),
    tx
      .select({
        sequenceId: receiptNumberWriteoffs.sequenceId,
        sequenceNumber: receiptNumberWriteoffs.sequenceNumber,
      })
      .from(receiptNumberWriteoffs)
      .where(
        and(
          eq(receiptNumberWriteoffs.tenantId, tenantId),
          inArray(receiptNumberWriteoffs.sequenceId, sequenceIds),
        ),
      ),
  );
  const bySequence = new Map<string, { sequenceNumber: number }[]>();
  for (const row of present) {
    const list = bySequence.get(row.sequenceId) ?? [];
    list.push({ sequenceNumber: row.sequenceNumber });
    bySequence.set(row.sequenceId, list);
  }
  return sequences
    .map((sequence) => ({
      sequenceId: sequence.id,
      deviceId: sequence.deviceId,
      prefix: sequence.prefix,
      lastNumber: sequence.lastNumber,
      missing: receiptGaps(sequence, bySequence.get(sequence.id) ?? []),
    }))
    .filter((entry) => entry.missing.length > 0);
}

export function createPosReceiptPort(): PosReceiptPort {
  return {
    issueForSale: allocateReceipt,
    findForOrder: findReceiptForOrder,
    voidForOrder: voidReceiptForOrder,
  };
}

/**
 * Same result as `receiptGapsForOutlet`, without loading every receipt the
 * outlet ever issued (bead legend-ain0, Tutup Hari recap). One SQL count per
 * sequence compares the receipts issued in 1..lastNumber with lastNumber;
 * only the sequences where they differ get the full missing-number scan.
 * Gaps are outlet-lifetime, not per business day: a hole stays reported on
 * every later day until the missing receipt merges in.
 */
export async function receiptGapsForOutletFast(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<
  {
    sequenceId: string;
    deviceId: string;
    prefix: string;
    lastNumber: number;
    missing: number[];
  }[]
> {
  const tenantId = context.tenant.tenantId;
  const counted = await tx
    .select({
      sequence: receiptSequences,
      issued:
        sql<number>`count(${posReceipts.sequenceNumber}) filter (where ${posReceipts.sequenceNumber} <= ${receiptSequences.lastNumber})`.mapWith(
          Number,
        ),
    })
    .from(receiptSequences)
    .leftJoin(
      posReceipts,
      and(
        eq(posReceipts.tenantId, receiptSequences.tenantId),
        eq(posReceipts.sequenceId, receiptSequences.id),
      ),
    )
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outletId as OutletId),
      ),
    )
    .groupBy(receiptSequences.id)
    .orderBy(asc(receiptSequences.prefix));
  // legend-0hzqw: a written-off number counts as present. The write-offs
  // returned have no receipt, so receipts + write-offs never overlap and the
  // count fast path stays exact.
  const writeoffs = await writeoffOrdinalsBySequence(
    tx,
    tenantId,
    counted.map((row) => row.sequence.id),
  );
  const suspect = counted.filter(
    (row) =>
      row.issued +
        countUpTo(writeoffs.get(row.sequence.id), row.sequence.lastNumber) !==
      row.sequence.lastNumber,
  );
  if (suspect.length === 0) return [];
  const issued = await tx
    .select({
      sequenceId: posReceipts.sequenceId,
      sequenceNumber: posReceipts.sequenceNumber,
    })
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        inArray(
          posReceipts.sequenceId,
          suspect.map((row) => row.sequence.id),
        ),
      ),
    );
  const bySequence = new Map<string, { sequenceNumber: number }[]>();
  for (const row of issued) {
    const list = bySequence.get(row.sequenceId) ?? [];
    list.push({ sequenceNumber: row.sequenceNumber });
    bySequence.set(row.sequenceId, list);
  }
  return suspect
    .map(({ sequence }) => ({
      sequenceId: sequence.id,
      deviceId: sequence.deviceId,
      prefix: sequence.prefix,
      lastNumber: sequence.lastNumber,
      missing: receiptGaps(sequence, [
        ...(bySequence.get(sequence.id) ?? []),
        ...asOrdinals(writeoffs.get(sequence.id)),
      ]),
    }))
    .filter((entry) => entry.missing.length > 0);
}

/**
 * Missing ordinals of ONE device run (bead legend-ain0): the implementation of
 * `posReceiptGapsPort` that app.ts installs, so Tutup Hari refuses and the
 * shift report lists the numbers (POS-06). Fast path like
 * `receiptGapsForOutletFast`: one SQL count first, the full scan only when the
 * count differs from lastNumber. Outlet-lifetime, not per business day.
 * legend-zsdd: a device may have several runs (retired ones plus the current
 * one); every run is checked. The port returns one entry per run (own prefix)
 * with a missing ordinal or a lost range, oldest run first, so P1 missing #3
 * and P2 missing #3 stay distinct. legend-yd0h8: `lost` is set for a run
 * retired as `edge_regressed` whose edge high-water is above the cloud
 * lastNumber. legend-0hzqw: ordinals written off by the owner count as present
 * and are listed in `writtenOff`; a run with only write-offs is still emitted
 * so the report shows them.
 */
export async function receiptGapsForDevice(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; deviceId: string },
): Promise<PosReceiptGapRun[]> {
  const tenantId = context.tenant.tenantId;
  const sequences = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, input.outletId as OutletId),
        eq(receiptSequences.deviceId, input.deviceId),
      ),
    )
    .orderBy(asc(receiptSequences.createdAt), asc(receiptSequences.id));
  const runs: PosReceiptGapRun[] = [];
  for (const sequence of sequences) {
    const { missing, writtenOff } = await receiptGapsOfRun(
      tx,
      tenantId,
      sequence,
    );
    const lost =
      sequence.retiredReason === "edge_regressed" &&
      sequence.edgeReportedNumber > sequence.lastNumber
        ? { from: sequence.lastNumber + 1, to: sequence.edgeReportedNumber }
        : null;
    if (missing.length > 0 || lost !== null || writtenOff.length > 0)
      runs.push({ prefix: sequence.prefix, missing, writtenOff, lost });
  }
  return runs;
}

/**
 * Missing and written-off ordinals of one run; fast path when receipts plus
 * write-offs cover lastNumber. The write-offs are read AFTER the receipt
 * count (as in `receiptGapsForOutletFast`): under READ COMMITTED a receipt
 * committed in between then drops its write-off from the list (NOT EXISTS),
 * so the sum can only fall short (a false gap, the slow path re-checks),
 * never hide a number that has neither a receipt nor a write-off.
 */
async function receiptGapsOfRun(
  tx: Tx,
  tenantId: TenantId,
  sequence: SequenceRow,
): Promise<{ missing: number[]; writtenOff: number[] }> {
  const [counted] = await tx
    .select({
      issued:
        sql<number>`count(*) filter (where ${posReceipts.sequenceNumber} <= ${sequence.lastNumber})`.mapWith(
          Number,
        ),
    })
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(posReceipts.sequenceId, sequence.id),
      ),
    );
  const writtenOff =
    (await writeoffOrdinalsBySequence(tx, tenantId, [sequence.id])).get(
      sequence.id,
    ) ?? [];
  if (sequence.lastNumber === 0) return { missing: [], writtenOff };
  if (
    (counted?.issued ?? 0) + countUpTo(writtenOff, sequence.lastNumber) ===
    sequence.lastNumber
  )
    return { missing: [], writtenOff };
  const issued = await tx
    .select({ sequenceNumber: posReceipts.sequenceNumber })
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(posReceipts.sequenceId, sequence.id),
      ),
    );
  return {
    missing: receiptGaps(sequence, [...issued, ...asOrdinals(writtenOff)]),
    writtenOff,
  };
}

/**
 * Written-off ordinals (legend-0hzqw) per sequence id, ascending, that still
 * have no receipt. A receipt that arrives later for a written-off number (late
 * sync) makes the write-off moot: the number is present through the receipt,
 * is not listed as written off, and is not counted twice by the fast paths.
 */
async function writeoffOrdinalsBySequence(
  tx: Tx,
  tenantId: TenantId,
  sequenceIds: string[],
): Promise<Map<string, number[]>> {
  const bySequence = new Map<string, number[]>();
  if (sequenceIds.length === 0) return bySequence;
  const rows = await tx
    .select({
      sequenceId: receiptNumberWriteoffs.sequenceId,
      sequenceNumber: receiptNumberWriteoffs.sequenceNumber,
    })
    .from(receiptNumberWriteoffs)
    .where(
      and(
        eq(receiptNumberWriteoffs.tenantId, tenantId),
        inArray(receiptNumberWriteoffs.sequenceId, sequenceIds),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(posReceipts)
            .where(
              and(
                eq(posReceipts.tenantId, receiptNumberWriteoffs.tenantId),
                eq(posReceipts.sequenceId, receiptNumberWriteoffs.sequenceId),
                eq(
                  posReceipts.sequenceNumber,
                  receiptNumberWriteoffs.sequenceNumber,
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(receiptNumberWriteoffs.sequenceNumber));
  for (const row of rows) {
    const list = bySequence.get(row.sequenceId) ?? [];
    list.push(row.sequenceNumber);
    bySequence.set(row.sequenceId, list);
  }
  return bySequence;
}

function countUpTo(numbers: number[] | undefined, lastNumber: number): number {
  return (numbers ?? []).filter((n) => n <= lastNumber).length;
}

function asOrdinals(
  numbers: number[] | undefined,
): { sequenceNumber: number }[] {
  return (numbers ?? []).map((sequenceNumber) => ({ sequenceNumber }));
}
