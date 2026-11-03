// Staff device pin hashing (bead legend-dxb; PRD v1.7 §3 F6 "Staf — PIN
// Perangkat", §6 B staff_pins "(T, E)").
//
// Pure functions, no database and no environment: the cloud API and the
// outlet edge run exactly this code, so a pin replicated to the edge verifies
// offline (EDG: the outlet keeps working without internet).
//
// Construction (`scrypt-hmac-sha256-v1`):
//   material = HMAC-SHA-256(pepper, "legend:staff-pin:v1\0tenant\0outlet\0user\0pin")
//   pinHash  = scrypt(material, salt[16 random bytes], N, r, p, 32) as hex
// - The pepper is tenant-bound (device-pin-pepper.ts), so a stolen database
//   alone cannot be brute-forced: 10^6 pins are trivial to enumerate without
//   a secret key in the loop.
// - The HMAC binds the hash to its tenant, outlet and user, so a hash copied
//   onto another staff row never verifies.
// - scrypt with a per-pin salt makes enumeration expensive even with the
//   pepper (an edge box that leaks both still costs 10^6 scrypt calls per pin).
// - Comparison is constant-time (timingSafeEqual).
// Never log, audit or emit the pin or the material.

import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions,
} from "node:crypto";
import {
  STAFF_PIN_HASH_ALGORITHM,
  type StaffPinEdgeRecord,
  type StaffPinKdfParams,
} from "@starter/shared/access/override";
import {
  isStaffPinLocked,
  recordStaffPinAttempt,
  staffPinPattern,
  type StaffPinAttemptState,
} from "@starter/shared/identity";

/** Default cost: ~16 MiB, tens of milliseconds per check on a POS-class box. */
export const STAFF_PIN_KDF: StaffPinKdfParams = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  keyLength: 32,
});

const SALT_BYTES = 16;
const MATERIAL_LABEL = "legend:staff-pin:v1";

export type StaffPinBinding = {
  readonly tenantId: string;
  readonly outletId: string;
  readonly userId: string;
};

export type StaffPinHash = {
  readonly salt: string;
  readonly pinHash: string;
  readonly params: StaffPinKdfParams;
};

function scrypt(
  password: BinaryLike,
  salt: BinaryLike,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

function material(
  pepper: Buffer,
  binding: StaffPinBinding,
  pin: string,
): Buffer {
  return createHmac("sha256", pepper)
    .update(
      [
        MATERIAL_LABEL,
        binding.tenantId.toLowerCase(),
        binding.outletId.toLowerCase(),
        binding.userId.toLowerCase(),
        pin,
      ].join("\u0000"),
      "utf8",
    )
    .digest();
}

function derive(
  pepper: Buffer,
  binding: StaffPinBinding,
  pin: string,
  salt: Buffer,
  params: StaffPinKdfParams,
): Promise<Buffer> {
  return scrypt(material(pepper, binding, pin), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    // 128 * N * r plus headroom; the default 32 MiB cap is enough for the
    // default cost, this keeps a stronger stored cost verifiable too.
    maxmem: 256 * params.N * params.r + 1024 * 1024,
  });
}

function assertPinShape(pin: string): void {
  // Never echo the value in the error.
  if (!staffPinPattern.test(pin)) throw new TypeError("Expected a 6-digit pin");
}

function assertPepper(pepper: Buffer): void {
  if (pepper.length < 32) throw new TypeError("Pin pepper must be 32 bytes");
}

/** Hash a new pin with a fresh random salt. */
export async function hashStaffPin(input: {
  readonly pepper: Buffer;
  readonly binding: StaffPinBinding;
  readonly pin: string;
  readonly params?: StaffPinKdfParams;
}): Promise<StaffPinHash> {
  assertPinShape(input.pin);
  assertPepper(input.pepper);
  const params = input.params ?? STAFF_PIN_KDF;
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(
    input.pepper,
    input.binding,
    input.pin,
    salt,
    params,
  );
  return {
    salt: salt.toString("base64"),
    pinHash: key.toString("hex"),
    params,
  };
}

/** Constant-time check of a pin against a stored hash. Never throws on a mismatch. */
export async function verifyStaffPinHash(input: {
  readonly pepper: Buffer;
  readonly binding: StaffPinBinding;
  readonly pin: string;
  readonly stored: StaffPinHash;
}): Promise<boolean> {
  assertPepper(input.pepper);
  if (!staffPinPattern.test(input.pin)) return false;
  const expected = Buffer.from(input.stored.pinHash, "hex");
  const salt = Buffer.from(input.stored.salt, "base64");
  if (expected.length !== input.stored.params.keyLength || salt.length === 0)
    return false;
  const actual = await derive(
    input.pepper,
    input.binding,
    input.pin,
    salt,
    input.stored.params,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Same cost as a real check, for an unknown user or a missing pin row, so the
 * answer time does not reveal which staff members have a pin.
 */
export async function burnStaffPinCheck(pepper: Buffer): Promise<void> {
  await derive(
    pepper,
    { tenantId: "-", outletId: "-", userId: "-" },
    "000000",
    randomBytes(SALT_BYTES),
    STAFF_PIN_KDF,
  );
}

export type OfflinePinResult =
  | { readonly outcome: "ok"; readonly state: StaffPinAttemptState }
  | { readonly outcome: "invalid"; readonly state: StaffPinAttemptState }
  | { readonly outcome: "locked"; readonly state: StaffPinAttemptState };

/**
 * Edge (offline) verification of a replicated record: no database, no
 * network. Applies the same §3 F6 counter as the cloud (shared machine
 * `recordStaffPinAttempt`): a locked record is refused without checking the
 * pin, a miss counts, the fifth locks, a correct pin resets. The caller stores
 * `state` locally and syncs it back; the edge must serialise attempts per
 * record (one at a time) exactly like the cloud row lock.
 */
export async function verifyStaffPinOffline(input: {
  readonly record: StaffPinEdgeRecord;
  readonly pepper: Buffer;
  readonly pin: string;
  readonly now: Date;
}): Promise<OfflinePinResult> {
  const { record } = input;
  if (record.algorithm !== STAFF_PIN_HASH_ALGORITHM)
    throw new TypeError("Unknown staff pin hash algorithm");
  const state: StaffPinAttemptState = {
    failedAttempts: record.failedAttempts,
    lockedUntil: record.lockedUntil,
  };
  if (isStaffPinLocked(state, input.now)) return { outcome: "locked", state };
  const correct = await verifyStaffPinHash({
    pepper: input.pepper,
    binding: record,
    pin: input.pin,
    stored: {
      salt: record.salt,
      pinHash: record.pinHash,
      params: record.params,
    },
  });
  const next = recordStaffPinAttempt({ state, correct, now: input.now });
  if (correct) return { outcome: "ok", state: next };
  return {
    outcome: next.lockedUntil === null ? "invalid" : "locked",
    state: next,
  };
}
