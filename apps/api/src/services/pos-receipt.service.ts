// POS receipt numbering (bead legend-93a, WS-04; PRD v1.7 §3 F8 "Nomor Struk
// Berurutan", §6 C `receipt_sequences`; POS-06; contract
// @starter/shared/pos receipts.ts).
//
// - One `receipt_sequences` row per (tenant, outlet, device); a sale without a
//   device (cloud / back-office POS) uses the outlet id as its device key.
// - Allocation is gapless because it runs inside the sale transaction: the
//   UPDATE ... last_number + 1 row lock serialises devices and a rollback of
//   the sale rolls the number back with it. Idempotent per order.
// - A void never returns a number: the row flips to `voided` and stays.
// - Cloud merge of an offline device run (`mergeDeviceReceiptRun`) backfills
//   missing ordinals (late/reversed batches too), is an idempotent replay and
//   advances `lastNumber` only over a complete 1..n run (else
//   RECEIPT_SEQUENCE_GAP, nothing written). It refuses the outlet-owned
//   (cloud) sequence, receipts whose order is not in the same tenant and
//   outlet, and an ordinal that is already taken by another receipt.
// The database triggers in pos-receipt.custom.sql are the backstop.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  CoreError,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  assertReceiptMatchesSequence,
  formatReceiptNumber,
  posReceiptSchema,
  PosError,
  receiptGaps,
  receiptPrefixSchema,
  receiptSequenceSchema,
  voidReasonSchema,
  type PosReceipt,
  type ReceiptSequence,
} from "@starter/shared/pos";
import { posOrders } from "../db/schema/pos-order.ts";
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

/** Existing sequence of the device, or a new one with the next free prefix. */
async function ensureSequence(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  deviceId: string,
): Promise<SequenceRow> {
  const existing = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (existing) return existing;
  await lockOutletSequences(tx, tenantId, outletId);
  // Another sale may have created it while this one waited for the lock.
  const created = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (created) return created;
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

/**
 * Cloud merge of an offline device run. The device's run is authoritative for
 * its ordinals. Incoming receipts missing in the cloud are inserted (above or
 * below the cloud `lastNumber`: late and reversed batches are fine), an
 * ordinal already present must be the very same receipt (replay is a no-op)
 * and a receipt voided offline is voided here too. The cloud `lastNumber`
 * moves to max(cloud, device) only when every ordinal 1..newLast exists after
 * the batch; otherwise nothing is written and RECEIPT_SEQUENCE_GAP lists the
 * missing ordinals (the device resends the full range). A device cannot use
 * the cloud-owned (outlet id) sequence and can only reference orders of its
 * own outlet.
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
  if (deviceId === outletId) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  await lockOutletSequences(tx, tenantId, outletId);
  const cloudRow = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (cloudRow) {
    if (cloudRow.prefix !== prefix)
      throw new PosError("RECEIPT_PREFIX_MISMATCH");
  } else {
    const used = await prefixesOfOutlet(tx, tenantId, outletId);
    if (used.has(prefix)) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  }
  const cloudLast = cloudRow?.lastNumber ?? 0;

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
  if (input.receipts.length > 0) {
    const orderIds = [...batchOrderIds];
    const orderRows = await tx
      .select({ orderId: posOrders.orderId })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.tenantId, tenantId),
          eq(posOrders.outletId, outletId),
          inArray(posOrders.orderId, orderIds),
        ),
      );
    const known = new Set<string>(orderRows.map((row) => row.orderId));
    for (const orderId of orderIds)
      if (!known.has(orderId)) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  }

  // Compare the batch with what the cloud already holds.
  const byOrdinal = new Map<number, ReceiptRow>();
  const cloudOrdinals = new Set<number>();
  if (cloudRow) {
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
    if (
      receipt.status === "voided" &&
      existing.status === "issued" &&
      receipt.voidedAt &&
      receipt.voidReason &&
      receipt.voidedBy
    )
      toVoid.push({ existing, receipt });
  }

  // Completeness: the sequence advances only over a run with no hole. A stale
  // batch (device.last <= cloud.last) never moves it and is never refused.
  const newLast = Math.max(cloudLast, input.sequence.lastNumber);
  if (input.sequence.lastNumber > cloudLast) {
    const missing: number[] = [];
    for (let n = 1; n <= newLast; n += 1)
      if (!cloudOrdinals.has(n) && !ordinals.has(n)) missing.push(n);
    if (missing.length > 0) {
      const shown = missing.slice(0, 20).join(", ");
      const more = missing.length > 20 ? ` (+${missing.length - 20} lagi)` : "";
      throw new PosError(
        "RECEIPT_SEQUENCE_GAP",
        `Ada nomor struk yang hilang pada perangkat ini: ${shown}${more}.`,
      );
    }
  }

  // Writes: sequence first (the retained trigger needs sequence_number <=
  // last_number), then receipts, all in the caller's transaction.
  let sequenceRow = cloudRow;
  if (!sequenceRow)
    sequenceRow = await insertSequence(tx, {
      tenantId,
      outletId,
      deviceId,
      prefix,
    });
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
    let snapshot = receipt.outletSnapshot;
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
      voidedAt: receipt.voidedAt ? new Date(receipt.voidedAt) : null,
      voidReason: receipt.voidReason,
      voidedBy: receipt.voidedBy,
      reprintCount: receipt.reprintCount,
      outletSnapshot: snapshot,
    });
  }
  for (const { existing, receipt } of toVoid)
    await tx
      .update(posReceipts)
      .set({
        status: "voided",
        voidedAt: new Date(receipt.voidedAt as string),
        voidReason: receipt.voidReason,
        voidedBy: receipt.voidedBy,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(posReceipts.tenantId, tenantId),
          eq(posReceipts.id, existing.id),
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
