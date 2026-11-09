// HR-03 sealing for payroll amounts (bead legend-gfcr). Same envelope and key
// as HRIS PII (lib/secrets.ts, AES-256-GCM under DATA_ENCRYPTION_KEY), with
// its own AAD namespace so a payroll ciphertext can never be opened as an
// employee field or moved to another row, table, field or tenant.
import { idr, type Idr } from "@starter/shared/core";
import { openSecret, sealSecret } from "./secrets.ts";

/** Bump with a re-seal job when the data key rotates. */
export const PAYROLL_SEAL_KEY_VERSION = 1;
const SUPPORTED_KEY_VERSIONS: ReadonlySet<number> = new Set([
  PAYROLL_SEAL_KEY_VERSION,
]);

export type PayrollSealBinding = {
  readonly tenantId: string;
  readonly table: "employee_pay_components" | "payslips";
  readonly rowId: string;
  readonly field: "amount" | "calculation";
};

function aadOf(binding: PayrollSealBinding, keyVersion: number): string {
  if (!SUPPORTED_KEY_VERSIONS.has(keyVersion))
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
  return Buffer.from(sealSecret(value, aadOf(binding, keyVersion)), "base64");
}

/** Opens a sealed column; throws (fail closed) on any mismatch. */
export function openPayrollValue(
  sealed: Buffer | Uint8Array,
  binding: PayrollSealBinding,
  keyVersion: number,
): string {
  return openSecret(
    Buffer.from(sealed).toString("base64"),
    aadOf(binding, keyVersion),
  );
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
