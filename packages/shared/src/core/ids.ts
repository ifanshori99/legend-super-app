// Identifier conventions (PRD v1.7 §6, decision recorded in
// docs/plan/contracts.md):
// - Every id is a UUID. Postgres stores every id, primary and foreign, in a
//   `uuid` column, so one column type joins everything.
// - Aggregates that PRD §6 marks "ULID (PK)" (orders, order_items, kitchen
//   tickets, stock_ledger, access tickets, event and outbox rows) get a
//   time-ordered ULID. On the wire and in TypeScript such an id is always the
//   26-character ULID text, including where another aggregate references it.
//   In Postgres it is stored losslessly in the same `uuid` column type
//   (ulidToUuid / uuidToUlid), so byte order still equals time order.
// No Node-only or browser-only APIs: randomness uses Web Crypto, which both
// Node (>= 19) and browsers expose as globalThis.crypto.

import { z } from "zod";

/** RFC 9562 UUID text, lowercase or uppercase. */
export const uuidSchema = z.uuid();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Canonical ULID text: 26 uppercase Crockford base32 characters. */
export const ulidSchema = z
  .string()
  .regex(ULID_PATTERN, "Expected a canonical 26-character ULID");

/** Branded UUID id for one aggregate, e.g. uuidIdSchema<"MenuItemId">(). */
export function uuidIdSchema<Brand extends string>() {
  return z.uuid().brand<Brand>();
}

/** Branded ULID id for one time-ordered aggregate, e.g. ulidIdSchema<"OrderId">(). */
export function ulidIdSchema<Brand extends string>() {
  return z
    .string()
    .regex(ULID_PATTERN, "Expected a canonical 26-character ULID")
    .brand<Brand>();
}

export type Uuid = z.infer<typeof uuidSchema>;
export type Ulid = z.infer<typeof ulidSchema>;

// Ids the core context types need. Every other aggregate declares its own
// branded id in its domain contract with uuidIdSchema / ulidIdSchema.
export const tenantIdSchema = uuidIdSchema<"TenantId">();
export const brandIdSchema = uuidIdSchema<"BrandId">();
export const outletIdSchema = uuidIdSchema<"OutletId">();
export const userIdSchema = uuidIdSchema<"UserId">();
export type TenantId = z.infer<typeof tenantIdSchema>;
export type BrandId = z.infer<typeof brandIdSchema>;
export type OutletId = z.infer<typeof outletIdSchema>;
export type UserId = z.infer<typeof userIdSchema>;

const TIME_MAX = 2 ** 48 - 1;
const RANDOM_MAX = (1n << 80n) - 1n;

// Web Crypto exists in Node >= 19 and every browser; typed locally because
// this package compiles against the plain ES library (no DOM, no Node types).
type WebCrypto = { getRandomValues<T extends Uint8Array>(array: T): T };

function randomBits80(): bigint {
  const bytes = new Uint8Array(10);
  (globalThis as unknown as { crypto: WebCrypto }).crypto.getRandomValues(
    bytes,
  );
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encodeUlid(time: number, random: bigint): Ulid {
  if (!Number.isInteger(time) || time < 0 || time > TIME_MAX)
    throw new RangeError(`ULID time out of range: ${time}`);
  let value = (BigInt(time) << 80n) | random;
  let text = "";
  for (let index = 0; index < 26; index += 1) {
    text = CROCKFORD[Number(value & 31n)] + text;
    value >>= 5n;
  }
  return text;
}

function decodeUlid(ulid: string): bigint {
  if (!ULID_PATTERN.test(ulid))
    throw new RangeError(`Not a canonical ULID: ${ulid}`);
  let value = 0n;
  for (const char of ulid)
    value = (value << 5n) | BigInt(CROCKFORD.indexOf(char));
  return value;
}

/** A new ULID for the given time (milliseconds since epoch). */
export function createUlid(time: number = Date.now()): Ulid {
  return encodeUlid(time, randomBits80());
}

/**
 * Returns a generator of strictly increasing ULIDs: ids made in the same
 * millisecond increment the random part, so per-device event streams (edge
 * outbox, offline POS) stay ordered. Use one factory per process or device.
 */
export function createUlidFactory(
  options: { now?: () => number } = {},
): () => Ulid {
  const now = options.now ?? Date.now;
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    const time = now();
    if (time <= lastTime) {
      if (lastRandom === RANDOM_MAX)
        throw new RangeError("ULID random part overflow");
      lastRandom += 1n;
    } else {
      lastTime = time;
      lastRandom = randomBits80();
    }
    return encodeUlid(lastTime, lastRandom);
  };
}

/** Milliseconds since epoch encoded in a ULID. */
export function ulidTimestamp(ulid: string): number {
  return Number(decodeUlid(ulid) >> 80n);
}

/** ULID text -> the `uuid` column value that stores it (lossless). */
export function ulidToUuid(ulid: string): string {
  const hex = decodeUlid(ulid).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `uuid` column value -> ULID text (inverse of ulidToUuid). */
export function uuidToUlid(uuid: string): Ulid {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex))
    throw new RangeError(`Not a UUID: ${uuid}`);
  const value = BigInt(`0x${hex}`);
  return encodeUlid(Number(value >> 80n), value & RANDOM_MAX);
}
