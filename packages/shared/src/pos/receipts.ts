// Receipt numbering (POS-06, PRD §3 F8 "Nomor Struk Berurutan", §6.C
// `receipt_sequences`, D40, F44): "Nomor struk berurutan tanpa celah per outlet
// dan per perangkat, termasuk saat offline (prefiks perangkat diikuti nomor
// urut). Struk yang di-void tetap tercatat dengan nomornya."
//
// One sequence row per (outlet, device). The device owns its own gapless run
// offline, and the prefix makes its numbers unique in the outlet, so two
// terminals never hand out the same receipt number. A void never returns a
// number: the receipt row stays with its ordinal and flips to `voided`.
//
// Prefix and ordinal are validated here (not in the database) so the edge
// runtime, the API and the print template all format the same string.

import { z } from "../core/index.ts";
import { PosError } from "./errors.ts";
import type { PosReceipt, ReceiptSequence } from "./schemas.ts";

/**
 * Prefix per device, e.g. `CLB-P1` (PRD: "prefiks perangkat"). A hyphen may
 * separate an outlet code from the terminal, but the prefix never starts or
 * ends with one, so `<prefix>-<ordinal>` parses back unambiguously.
 */
export const receiptRunPrefixSchema = z
  .string()
  .regex(
    /^[A-Z0-9](?:[A-Z0-9-]{0,10}[A-Z0-9])?$/,
    "Receipt prefixes are 1-12 uppercase letters, digits or inner hyphens",
  );

/**
 * 1271 F1 (design edge-cloud-failover.md N1/N2): the numbering series of a run.
 * `device` = numbered by the outlet edge (or the device offline), `cloud` =
 * the cloud-owned `C` run, `failover` = `F<n>`, numbered by the cloud only
 * while the outlet's edge is down. Each series has exactly one allocator.
 * O1 (cloud-only-release.md §2): `offline` = `L<n>`, one epoch of a tablet
 * selling offline; the tablet numbers it, the cloud only takes the numbers in.
 */
export const RECEIPT_SERIES = [
  "device",
  "cloud",
  "failover",
  "offline",
] as const;
export const receiptSeriesSchema = z.enum(RECEIPT_SERIES);
export type ReceiptSeries = z.infer<typeof receiptSeriesSchema>;

/** `F1`..`F9999`: the failover run of one device (cloud only, never edge-bound). */
export const FAILOVER_RECEIPT_PREFIX_PATTERN = /^F[0-9]{1,4}$/;
/** Any `F<digits>` prefix; refused as a caller-chosen or edge-bound prefix. */
const RESERVED_FAILOVER_PREFIX = /^F[0-9]+$/;

/** O1: `L1`..`L999999`, one offline epoch of one device (cloud-issued only). */
export const OFFLINE_RECEIPT_PREFIX_PATTERN = /^L[0-9]{1,6}$/;
/** Any `L<digits>` prefix; refused as a caller-chosen or edge-bound prefix. */
const RESERVED_OFFLINE_PREFIX = /^L[0-9]+$/;

export function isOfflineReceiptPrefix(prefix: string): boolean {
  return OFFLINE_RECEIPT_PREFIX_PATTERN.test(prefix);
}

export function isFailoverReceiptPrefix(prefix: string): boolean {
  return FAILOVER_RECEIPT_PREFIX_PATTERN.test(prefix);
}

/**
 * A device (or edge-bound) prefix. `F<digits>` is reserved for the cloud
 * failover series (1271 F1), so a caller or an edge can never claim it. Use
 * `receiptRunPrefixSchema` where any series may appear (cloud DTOs, formatting).
 */
export const receiptPrefixSchema = receiptRunPrefixSchema
  .refine(
    (prefix) => !RESERVED_FAILOVER_PREFIX.test(prefix),
    "Receipt prefix F<number> is reserved for cloud failover sales",
  )
  .refine(
    (prefix) => !RESERVED_OFFLINE_PREFIX.test(prefix),
    "Receipt prefix L<number> is reserved for offline tablet sales",
  );
export type ReceiptPrefix = z.infer<typeof receiptPrefixSchema>;

/**
 * Fixed prefix of the cloud-owned sequence (key `deviceId = outletId`, sales
 * without a device). Device sequences use `P1, P2, ...` and never `"C"`.
 */
export const CLOUD_RECEIPT_PREFIX = "C";

/** Digits after the prefix; six covers a million receipts per device. */
export const RECEIPT_ORDINAL_DIGITS = 6;
export const RECEIPT_MAX_ORDINAL = 999_999_999;

/** `CLB-P1-000042`: prefix, hyphen, zero-padded ordinal. */
export const receiptNumberSchema = z
  .string()
  .regex(
    /^[A-Z0-9](?:[A-Z0-9-]{0,10}[A-Z0-9])?-\d{6,9}$/,
    "Receipt numbers are <prefix>-<ordinal padded to 6>",
  );
export type ReceiptNumber = z.infer<typeof receiptNumberSchema>;

function assertOrdinal(sequenceNumber: number): void {
  if (
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 1 ||
    sequenceNumber > RECEIPT_MAX_ORDINAL
  )
    throw new RangeError(`Invalid receipt ordinal: ${sequenceNumber}`);
}

export function formatReceiptNumber(
  prefix: string,
  sequenceNumber: number,
): ReceiptNumber {
  receiptRunPrefixSchema.parse(prefix);
  assertOrdinal(sequenceNumber);
  return receiptNumberSchema.parse(
    `${prefix}-${String(sequenceNumber).padStart(RECEIPT_ORDINAL_DIGITS, "0")}`,
  );
}

export function parseReceiptNumber(number: string): {
  prefix: string;
  sequenceNumber: number;
} {
  receiptNumberSchema.parse(number);
  const dash = number.lastIndexOf("-");
  const prefix = number.slice(0, dash);
  const sequenceNumber = Number(number.slice(dash + 1));
  assertOrdinal(sequenceNumber);
  return { prefix, sequenceNumber };
}

/**
 * The number the next sale on this device gets. Pure: the caller persists the
 * returned `sequence` in the same transaction as the receipt (the edge queue
 * does the same offline), so a crash cannot issue a number twice.
 */
export function nextReceiptNumber(sequence: ReceiptSequence): {
  sequenceNumber: number;
  number: ReceiptNumber;
  sequence: ReceiptSequence;
} {
  receiptRunPrefixSchema.parse(sequence.prefix);
  const sequenceNumber = sequence.lastNumber + 1;
  assertOrdinal(sequenceNumber);
  return {
    sequenceNumber,
    number: formatReceiptNumber(sequence.prefix, sequenceNumber),
    sequence: { ...sequence, lastNumber: sequenceNumber },
  };
}

/** POS-06: the printed number must be this device's prefix and ordinal. */
export function assertReceiptMatchesSequence(
  sequence: Pick<ReceiptSequence, "prefix" | "lastNumber">,
  receipt: Pick<PosReceipt, "number" | "sequenceNumber">,
): void {
  const expected = formatReceiptNumber(sequence.prefix, receipt.sequenceNumber);
  if (receipt.number !== expected)
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  if (receipt.sequenceNumber > sequence.lastNumber)
    throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
}

/**
 * Ordinals a device issued but did not deliver — a lost offline receipt, not
 * a formatting problem. The API refuses to close the day while this is
 * non-empty (POS-06 has no acceptable gap).
 */
export function receiptGaps(
  sequence: Pick<ReceiptSequence, "lastNumber">,
  receipts: readonly Pick<PosReceipt, "sequenceNumber">[],
): number[] {
  const present = new Set(receipts.map((receipt) => receipt.sequenceNumber));
  const gaps: number[] = [];
  for (let ordinal = 1; ordinal <= sequence.lastNumber; ordinal += 1)
    if (!present.has(ordinal)) gaps.push(ordinal);
  return gaps;
}

/**
 * POS-06 in one check: every ordinal 1..lastNumber has exactly one receipt,
 * each number matches the device prefix, and no row mentions a number the
 * device has not issued. Voided receipts count — that is the point.
 */
export function assertGaplessReceipts(
  sequence: ReceiptSequence,
  receipts: readonly PosReceipt[],
): void {
  for (const receipt of receipts) {
    if (
      receipt.tenantId !== sequence.tenantId ||
      receipt.outletId !== sequence.outletId ||
      receipt.deviceId !== sequence.deviceId
    )
      throw new PosError("RECEIPT_PREFIX_MISMATCH");
    assertReceiptMatchesSequence(sequence, receipt);
  }
  const ordinals = new Set(receipts.map((receipt) => receipt.sequenceNumber));
  if (ordinals.size !== receipts.length)
    throw new PosError("RECEIPT_SEQUENCE_GAP");
  if (receiptGaps(sequence, receipts).length > 0)
    throw new PosError("RECEIPT_SEQUENCE_GAP");
  if (receipts.some((receipt) => receipt.sequenceNumber > sequence.lastNumber))
    throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
}

/**
 * Cloud merge after an offline run. The device's own run is authoritative for
 * its ordinals, so it may only move forward; a stale device that re-sends an
 * older `lastNumber` would reissue numbers, which POS-06 forbids. Identical
 * lastNumber is an idempotent replay and is accepted unchanged.
 */
export function mergeDeviceReceiptSequence(
  cloud: ReceiptSequence,
  device: ReceiptSequence,
): ReceiptSequence {
  if (
    cloud.tenantId !== device.tenantId ||
    cloud.outletId !== device.outletId ||
    cloud.deviceId !== device.deviceId ||
    cloud.prefix !== device.prefix
  )
    throw new PosError("RECEIPT_PREFIX_MISMATCH");
  if (device.lastNumber < cloud.lastNumber)
    throw new PosError("RECEIPT_SEQUENCE_REGRESSION");
  return device.lastNumber === cloud.lastNumber
    ? cloud
    : { ...cloud, lastNumber: device.lastNumber };
}
