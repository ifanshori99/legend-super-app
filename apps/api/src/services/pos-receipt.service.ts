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
// - Cloud merge of an offline device run (`mergeDeviceReceiptRun`) only moves
//   forward and is an idempotent replay. It refuses the outlet-owned (cloud)
//   sequence, a `lastNumber` beyond max(cloud, incoming ordinals), receipts
//   whose order is not in the same tenant and outlet, and a stale batch
//   (`lastNumber` below the cloud's) unless it is a pure no-op replay.
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
  mergeDeviceReceiptSequence,
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
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
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
 * its ordinals: the sequence only moves forward, incoming receipts are inserted
 * once (replay is a no-op) and a receipt voided offline is voided here too.
 * A device cannot claim numbers it does not send, cannot use the cloud-owned
 * (outlet id) sequence and can only reference orders of its own outlet.
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
    receipts: PosReceipt[];
  },
): Promise<{ sequence: ReceiptSequence; inserted: number }> {
  const tenantId = context.tenant.tenantId;
  const { deviceId, prefix } = input.sequence;
  const outletId = input.sequence.outletId as OutletId;
  // The outlet id is the key of the cloud-owned sequence; a device never owns it.
  if (deviceId === outletId) throw new PosError("RECEIPT_PREFIX_MISMATCH");
  await lockOutletSequences(tx, tenantId, outletId);
  let cloudRow = await findSequenceRow(tx, tenantId, outletId, deviceId);
  if (!cloudRow) {
    const used = await prefixesOfOutlet(tx, tenantId, outletId);
    if (used.has(prefix)) throw new PosError("RECEIPT_PREFIX_MISMATCH");
    cloudRow = await insertSequence(tx, {
      tenantId,
      outletId,
      deviceId,
      prefix,
    });
  }
  const cloud = toReceiptSequence(cloudRow);
  if (cloud.prefix !== prefix) throw new PosError("RECEIPT_PREFIX_MISMATCH");

  // Validate every incoming receipt before anything is written.
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
  }
  if (input.receipts.length > 0) {
    const orderIds = [...new Set(input.receipts.map((r) => r.orderId))];
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

  const maxIncoming = input.receipts.reduce(
    (max, receipt) => Math.max(max, receipt.sequenceNumber),
    0,
  );
  if (input.sequence.lastNumber > Math.max(cloud.lastNumber, maxIncoming))
    throw new CoreError(
      "VALIDATION_ERROR",
      "Nomor terakhir perangkat melebihi struk yang dikirim.",
    );

  if (input.sequence.lastNumber < cloud.lastNumber) {
    // Stale batch: only an exact replay of what the cloud already holds.
    for (const receipt of input.receipts) {
      const [existing] = await tx
        .select()
        .from(posReceipts)
        .where(
          and(
            eq(posReceipts.tenantId, tenantId),
            eq(posReceipts.orderId, receipt.orderId),
          ),
        );
      if (
        !existing ||
        existing.number !== receipt.number ||
        existing.sequenceId !== cloud.id ||
        existing.sequenceNumber !== receipt.sequenceNumber ||
        (existing.status !== receipt.status && existing.status !== "voided")
      )
        throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
    }
    return { sequence: cloud, inserted: 0 };
  }

  const merged = mergeDeviceReceiptSequence(cloud, {
    ...cloud,
    prefix,
    lastNumber: input.sequence.lastNumber,
  });
  let sequence = cloud;
  if (merged.lastNumber !== cloud.lastNumber) {
    const [row] = await tx
      .update(receiptSequences)
      .set({ lastNumber: merged.lastNumber, updatedAt: sql`now()` })
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.id, cloud.id),
        ),
      )
      .returning();
    if (!row) throw new Error("Receipt sequence update returned no row");
    sequence = toReceiptSequence(row);
  }

  let inserted = 0;
  for (const receipt of input.receipts) {
    const rows = await tx
      .insert(posReceipts)
      .values({
        id: receipt.id,
        tenantId,
        outletId,
        orderId: receipt.orderId,
        sequenceId: sequence.id,
        deviceId,
        number: receipt.number,
        sequenceNumber: receipt.sequenceNumber,
        status: receipt.status,
        issuedAt: new Date(receipt.issuedAt),
        voidedAt: receipt.voidedAt ? new Date(receipt.voidedAt) : null,
        voidReason: receipt.voidReason,
        voidedBy: receipt.voidedBy,
        reprintCount: receipt.reprintCount,
      })
      .onConflictDoNothing()
      .returning({ id: posReceipts.id });
    if (rows.length > 0) {
      inserted += 1;
      continue;
    }
    // Pre-existing row: it must be this very receipt, else the device run
    // disagrees with what the cloud already issued.
    const [existing] = await tx
      .select()
      .from(posReceipts)
      .where(
        and(
          eq(posReceipts.tenantId, tenantId),
          eq(posReceipts.orderId, receipt.orderId),
        ),
      );
    if (
      !existing ||
      existing.number !== receipt.number ||
      existing.sequenceId !== sequence.id ||
      existing.sequenceNumber !== receipt.sequenceNumber
    )
      throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
    if (
      receipt.status === "voided" &&
      existing.status === "issued" &&
      receipt.voidedAt &&
      receipt.voidReason &&
      receipt.voidedBy
    )
      await tx
        .update(posReceipts)
        .set({
          status: "voided",
          voidedAt: new Date(receipt.voidedAt),
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
  }
  return { sequence, inserted };
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
