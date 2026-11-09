// POS receipt numbering (bead legend-93a, WS-04; PRD v1.7 §3 F8 "Nomor Struk
// Berurutan", §6 C `receipt_sequences`; POS-06; contract
// @starter/shared/pos receipts.ts).
//
// - One `receipt_sequences` row per (tenant, outlet, device); a sale without a
//   device (cloud / back-office POS) uses the outlet id as its device key and
//   the fixed prefix `C`. Device sequences are `P1, P2, ...`; an edge never
//   creates one and refuses a sale without a verified device.
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
// The database triggers in pos-receipt.custom.sql are the backstop.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { posOrders, posOrderVoids } from "../db/schema/pos-order.ts";
import { orders } from "../db/schema/qr-order.ts";
import { legalEntities, outlets } from "../db/schema/platform-org.ts";
import {
  posReceipts,
  receiptSequences,
  type PosReceiptOutletSnapshot,
} from "../db/schema/pos-receipt.ts";
import type { PosReceiptPort } from "./pos-order-ports.ts";
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
      ),
    );
  return row;
}

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

/** First of `P1`, `P2`, ... not used by another device of the outlet. */
function nextFreePrefix(used: ReadonlyMap<string, string>): string {
  for (let n = 1; ; n += 1) if (!used.has(`P${n}`)) return `P${n}`;
}

async function insertSequence(
  tx: Tx,
  input: {
    tenantId: TenantId;
    outletId: OutletId;
    deviceId: string;
    prefix: string;
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
    })
    .returning();
  if (!row) throw new Error("Receipt sequence insert returned no row");
  return row;
}

/**
 * Existing sequence of the key. The outlet id key is the cloud-owned sequence
 * (prefix `C`). A device key gets a new row with the next free `P<n>` prefix in
 * the cloud; an edge never invents one (the cloud provisions it first).
 */
async function ensureSequence(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  deviceId: string,
): Promise<SequenceRow> {
  const existing = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (existing) return existing;
  const cloudOwned = deviceId === outletId;
  if (!cloudOwned && getEdgeRuntimeState().edgeMode)
    throw new PosError("RECEIPT_SEQUENCE_NOT_PROVISIONED");
  await lockOutletSequences(tx, tenantId, outletId);
  // Another sale may have created it while this one waited for the lock.
  const created = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (created) return created;
  if (cloudOwned)
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
  if (input.deviceId === null && getEdgeRuntimeState().edgeMode)
    throw new PosError("RECEIPT_DEVICE_REQUIRED");
  const tenantId = context.tenant.tenantId;
  const deviceKey = input.deviceId ?? input.outletId;
  const outletId = input.outletId as OutletId;
  const sequence = await ensureSequence(tx, tenantId, outletId, deviceKey);
  // The row lock taken here serialises every device sale on this sequence.
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
      ),
    )
    .returning({
      prefix: receiptSequences.prefix,
      lastNumber: receiptSequences.lastNumber,
    });
  if (!advanced) throw new Error("Receipt sequence update returned no row");
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
  const cloudRow = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (!cloudRow) throw new PosError("RECEIPT_SEQUENCE_NOT_PROVISIONED");
  if (cloudRow.prefix !== prefix) throw new PosError("RECEIPT_PREFIX_MISMATCH");
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
  const newLast = Math.max(cloudLast, input.sequence.lastNumber);
  if (input.sequence.lastNumber > cloudLast) {
    // Stops after 21 holes: the walk is bounded by the rows present plus 21.
    const missing: number[] = [];
    for (let n = 1; n <= newLast && missing.length <= 20; n += 1)
      if (!cloudOrdinals.has(n) && !ordinals.has(n)) missing.push(n);
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
    const [row] = await tx
      .update(receiptSequences)
      .set({ lastNumber: newLast, updatedAt: sql`now()` })
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
  const issued = await tx
    .select({
      sequenceId: posReceipts.sequenceId,
      sequenceNumber: posReceipts.sequenceNumber,
    })
    .from(posReceipts)
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(posReceipts.outletId, outletId as OutletId),
      ),
    );
  const bySequence = new Map<string, { sequenceNumber: number }[]>();
  for (const row of issued) {
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
