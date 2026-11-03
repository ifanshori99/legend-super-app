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
import { blindIndex, openSecret, sealSecret } from "./secrets.ts";
import { HttpError } from "./http-error.ts";

/**
 * Key version written with every new seal. lib/secrets.ts holds exactly one
 * data key today; rotation adds a version here plus a re-seal job.
 */
export const HRIS_PII_KEY_VERSION = 1;
const SUPPORTED_KEY_VERSIONS: ReadonlySet<number> = new Set([
  HRIS_PII_KEY_VERSION,
]);

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
  return Buffer.from(sealSecret(value, aadOf(binding, keyVersion)), "base64");
}

/** Opens a sealed column; throws (fail closed) on any mismatch. */
export function openHrisPii(
  sealed: Buffer | Uint8Array,
  binding: HrisPiiBinding,
  keyVersion: number,
): string {
  assertKeyVersion(keyVersion);
  return openSecret(
    Buffer.from(sealed).toString("base64"),
    aadOf(binding, keyVersion),
  );
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
