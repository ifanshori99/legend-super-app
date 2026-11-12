// HR-03 sealing for payroll amounts (bead legend-gfcr). Same envelope and key
// ring as HRIS PII (lib/hris-pii.ts: v1 = DATA_ENCRYPTION_KEY, v2+ from
// HRIS_PII_KEYS, active = HRIS_PII_ACTIVE_KEY_VERSION; legend-snhxw), with its
// own AAD namespace so a payroll ciphertext can never be opened as an employee
// field or moved to another row, table, field or tenant. The row's
// `pii_key_version` says which key sealed it; worker/hris-pii-reseal.job.ts
// moves old rows to the active version after a rotation.
import { idr, type Idr } from "@starter/shared/core";
import {
  HRIS_PII_KEY_VERSION,
  hrisPiiRingKey,
  isHrisPiiKeyVersionSupported,
} from "./hris-pii.ts";
import {
  openSecret,
  openSecretWithKey,
  sealSecret,
  sealSecretWithKey,
} from "./secrets.ts";

/** Key version written with every new payroll seal (the ring's active one). */
export const PAYROLL_SEAL_KEY_VERSION: number = HRIS_PII_KEY_VERSION;

export type PayrollSealBinding = {
  readonly tenantId: string;
  readonly table:
    | "employee_pay_components"
    | "payslips"
    | "payroll_rapels"
    | "payroll_rapel_items";
  readonly rowId: string;
  readonly field: "amount" | "calculation";
};

function aadOf(binding: PayrollSealBinding, keyVersion: number): string {
  if (!isHrisPiiKeyVersionSupported(keyVersion))
    throw new Error("Unsupported payroll seal key version");
  if (!binding.tenantId || !binding.rowId)
    throw new TypeError("Payroll sealing needs a tenant and a row");
  return [
    "payroll",
    binding.table,
    binding.tenantId.toLowerCase(),
    binding.rowId.toLowerCase(),
    binding.field,
    `k${keyVersion}`,
  ].join(":");
}

/** Seals a string for its row; the result goes in a BYTEA column. */
export function sealPayrollValue(
  value: string,
  binding: PayrollSealBinding,
  keyVersion: number = PAYROLL_SEAL_KEY_VERSION,
): Buffer {
  const aad = aadOf(binding, keyVersion);
  const key = hrisPiiRingKey(keyVersion);
  return Buffer.from(
    key ? sealSecretWithKey(key, value, aad) : sealSecret(value, aad),
    "base64",
  );
}

/** Opens a sealed column; throws (fail closed) on any mismatch. */
export function openPayrollValue(
  sealed: Buffer | Uint8Array,
  binding: PayrollSealBinding,
  keyVersion: number,
): string {
  const aad = aadOf(binding, keyVersion);
  const envelope = Buffer.from(sealed).toString("base64");
  const key = hrisPiiRingKey(keyVersion);
  return key
    ? openSecretWithKey(key, envelope, aad)
    : openSecret(envelope, aad);
}

/** Whole-rupiah amount, sealed as its decimal string. */
export function sealPayrollAmount(
  amount: Idr,
  binding: PayrollSealBinding,
  keyVersion: number = PAYROLL_SEAL_KEY_VERSION,
): Buffer {
  return sealPayrollValue(String(idr(amount)), binding, keyVersion);
}

export function openPayrollAmount(
  sealed: Buffer | Uint8Array,
  binding: PayrollSealBinding,
  keyVersion: number,
): Idr {
  const text = openPayrollValue(sealed, binding, keyVersion);
  if (!/^-?(0|[1-9][0-9]{0,15})$/.test(text))
    throw new Error("Sealed payroll amount is malformed");
  return idr(Number(text));
}
