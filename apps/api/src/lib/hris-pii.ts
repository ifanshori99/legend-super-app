// HRIS field encryption (PRD v1.7 §2 Keamanan "Kontak, NIK, NPWP, rekening,
// dan gaji dienkripsi di tingkat aplikasi; pencarian memakai blind index
// (HMAC)"; §6 H `*_encrypted` BYTEA; HR-03; bead legend-qe1z).
//
// Built on lib/secrets.ts (AES-256-GCM, random nonce, versioned envelope, key
// from DATA_ENCRYPTION_KEY — never a key in code):
// - `sealHrisPii` returns the envelope as bytes for a BYTEA column. The AAD
//   binds the ciphertext to tenant + table + row + field + key version, so a
//   value copied to another employee, another column or another tenant, or a
//   row whose `pii_key_version` was edited, fails to open.
// - `hrisBlindIndex` is an HMAC-SHA256 over the normalized value with a
//   tenant-separated purpose: equal values match inside one tenant only, and
//   the same NIK in two tenants yields unrelated digests.
// - `normalizeHrisPii` gives every value one canonical form before it is
//   sealed or indexed, so "3273.0101-..." and "32730101..." are one NIK.
//
// Nothing here logs, and errors never echo the value.

import {
  HRIS_PII_FIELDS,
  maskPiiValue,
  type HrisPiiFieldName,
  type MaskedPiiValue,
} from "@starter/shared/hris";
import { env } from "../config/env.ts";
import {
  blindIndex,
  openSecret,
  openSecretWithKey,
  sealSecretBaseKey,
  sealSecretWithKey,
} from "./secrets.ts";
import { HttpError } from "./http-error.ts";
import {
  assertHrisPiiActiveVersion,
  parseHrisPiiKeys,
} from "./hris-pii-keys.ts";

// Key ring (legend-33mj). Version 1 is the data key of lib/secrets.ts, so data
// sealed before rotation stays readable. Versions >= 2 come from HRIS_PII_KEYS;
// HRIS_PII_ACTIVE_KEY_VERSION picks the one new seals use. config/env.ts
// validates both at boot; the ring is resolved once at module load. Moving
// existing rows to the active version is worker/hris-pii-reseal.job.ts.
const EXTRA_KEYS = parseHrisPiiKeys(env.HRIS_PII_KEYS);
assertHrisPiiActiveVersion(env.HRIS_PII_ACTIVE_KEY_VERSION, EXTRA_KEYS);

/** Key version written with every new seal (the ring's active version). */
export const HRIS_PII_KEY_VERSION: number = env.HRIS_PII_ACTIVE_KEY_VERSION;
const SUPPORTED_KEY_VERSIONS: ReadonlySet<number> = new Set([
  1,
  ...EXTRA_KEYS.keys(),
]);

// The blind index (`hrisBlindIndex`, `hrisRequestFingerprint`) is NOT rotated:
// it stays an HMAC under the version 1 data key, so equality lookups and the
// unique indexes on `*_hmac` stay valid across rotations. Only the sealed
// ciphertext columns move between key versions.

/**
 * Key-ring lookup for sibling sealers (lib/payroll-sealed.ts, legend-snhxw):
 * payroll values share this ring, so one rotation and one retirement of v1
 * cover HRIS and payroll. Version 1 has no entry here (it is the data key of
 * lib/secrets.ts); callers fall back to sealSecret/openSecret for it.
 */
export function isHrisPiiKeyVersionSupported(keyVersion: number): boolean {
  return SUPPORTED_KEY_VERSIONS.has(keyVersion);
}
export function hrisPiiRingKey(keyVersion: number): Buffer | undefined {
  return EXTRA_KEYS.get(keyVersion);
}

/** Wire names of the sealed employee fields (contract employeePiiSchema keys). */
export const HRIS_EMPLOYEE_PII_FIELDS = [
  "nik",
  "npwp",
  "bpjsKesNo",
  "bpjsTkNo",
  "bankAccount",
  "emergencyContactName",
  "emergencyContactPhone",
] as const;
export type HrisEmployeePiiField = (typeof HRIS_EMPLOYEE_PII_FIELDS)[number];
/** Every sealed HRIS value: the employee fields plus the contract salary. */
export type HrisSealedField = HrisEmployeePiiField | "salarySnapshot";

/** Wire field → contract metadata (HRIS_PII_FIELDS entry). */
const CONTRACT_FIELD: Record<HrisSealedField, HrisPiiFieldName> = {
  nik: "employeeNik",
  npwp: "employeeNpwp",
  bpjsKesNo: "employeeBpjsKes",
  bpjsTkNo: "employeeBpjsTk",
  bankAccount: "employeeBankAccount",
  emergencyContactName: "employeeEmergencyContactName",
  emergencyContactPhone: "employeeEmergencyContactPhone",
  salarySnapshot: "contractSalarySnapshot",
};

export function hrisPiiDefinition(field: HrisSealedField) {
  return HRIS_PII_FIELDS[CONTRACT_FIELD[field]];
}

/** True when the field has a blind index column (exact lookup/uniqueness). */
export function hrisPiiHasBlindIndex(field: HrisSealedField): boolean {
  return hrisPiiDefinition(field).blindIndex !== null;
}

function invalid(field: HrisSealedField): never {
  // The value itself is never part of the message.
  throw new HttpError(422, "VALIDATION_ERROR", `Format ${field} tidak valid.`);
}

const digitsOnly = (raw: string) => raw.replace(/[\s.\-/]/g, "");

/**
 * Canonical form of a value. Identity numbers are digits only (separators are
 * dropped); NIK is the 16-digit population number and NPWP 15 or 16 digits
 * (16 = NIK-based NPWP); BPJS numbers keep the contract's 8–20 length; a bank
 * account is upper-case alphanumerics. Names are trimmed and single-spaced.
 */
export function normalizeHrisPii(field: HrisSealedField, raw: string): string {
  if (typeof raw !== "string") invalid(field);
  switch (field) {
    case "nik": {
      const value = digitsOnly(raw);
      if (!/^[0-9]{16}$/.test(value)) invalid(field);
      return value;
    }
    case "npwp": {
      const value = digitsOnly(raw);
      if (!/^[0-9]{15,16}$/.test(value)) invalid(field);
      return value;
    }
    case "bpjsKesNo":
    case "bpjsTkNo": {
      const value = digitsOnly(raw);
      if (!/^[0-9]{8,20}$/.test(value)) invalid(field);
      return value;
    }
    case "bankAccount": {
      const value = raw.replace(/[\s.-]/g, "").toUpperCase();
      if (!/^[0-9A-Z]{6,34}$/.test(value)) invalid(field);
      return value;
    }
    case "emergencyContactName": {
      const value = raw.trim().replace(/\s+/g, " ");
      if (value.length < 1 || value.length > 150) invalid(field);
      return value;
    }
    case "emergencyContactPhone": {
      const value = raw.replace(/[\s\-().]/g, "");
      if (!/^\+?[0-9]{6,20}$/.test(value)) invalid(field);
      return value;
    }
    case "salarySnapshot": {
      const value = raw.trim();
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) invalid(field);
      if (!Number.isSafeInteger(Number(value))) invalid(field);
      return value;
    }
  }
}

export type HrisPiiBinding = {
  readonly tenantId: string;
  /** Table that owns the row, e.g. `employees`. */
  readonly table: "employees" | "employment_contracts";
  readonly rowId: string;
  readonly field: HrisSealedField;
};

function aadOf(binding: HrisPiiBinding, keyVersion: number): string {
  if (!binding.tenantId || !binding.rowId)
    throw new TypeError("HRIS PII needs a tenant and a row");
  return [
    "hris",
    binding.table,
    binding.tenantId.toLowerCase(),
    binding.rowId.toLowerCase(),
    binding.field,
    `k${keyVersion}`,
  ].join(":");
}

function assertKeyVersion(keyVersion: number): void {
  if (!SUPPORTED_KEY_VERSIONS.has(keyVersion))
    throw new Error("Unsupported HRIS PII key version");
}

/** Seals a normalized value for its row; the result goes in a BYTEA column. */
export function sealHrisPii(
  value: string,
  binding: HrisPiiBinding,
  keyVersion: number = HRIS_PII_KEY_VERSION,
): Buffer {
  assertKeyVersion(keyVersion);
  const aad = aadOf(binding, keyVersion);
  const extra = EXTRA_KEYS.get(keyVersion);
  return Buffer.from(
    extra
      ? sealSecretWithKey(extra, value, aad)
      : sealSecretBaseKey(value, aad),
    "base64",
  );
}

/** Opens a sealed column; throws (fail closed) on any mismatch. */
export function openHrisPii(
  sealed: Buffer | Uint8Array,
  binding: HrisPiiBinding,
  keyVersion: number,
): string {
  assertKeyVersion(keyVersion);
  const envelope = Buffer.from(sealed).toString("base64");
  const aad = aadOf(binding, keyVersion);
  const extra = EXTRA_KEYS.get(keyVersion);
  return extra
    ? openSecretWithKey(extra, envelope, aad)
    : openSecret(envelope, aad);
}

/** Tenant-separated HMAC blind index of a normalized value. */
export function hrisBlindIndex(
  field: HrisSealedField,
  tenantId: string,
  normalized: string,
): string {
  if (!hrisPiiHasBlindIndex(field))
    throw new TypeError(`${field} has no blind index`);
  return blindIndex(normalized, `hris:${field}:${tenantId.toLowerCase()}`);
}

/** HMAC of an arbitrary request, for idempotency fingerprints that may contain PII. */
export function hrisRequestFingerprint(
  tenantId: string,
  request: unknown,
): string {
  return blindIndex(
    JSON.stringify(request),
    `hris:idempotency:${tenantId.toLowerCase()}`,
  );
}

/** The only form of a value that reaches a client (contract MaskedPiiValue). */
export function maskHrisPii(
  field: HrisSealedField,
  plaintext: string,
  keyVersion: number,
): MaskedPiiValue {
  return {
    masked: maskPiiValue(plaintext, hrisPiiDefinition(field).maskRule),
    keyVersion,
  };
}
