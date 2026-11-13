// HR-03 sealing for payroll amounts (bead legend-gfcr). Same envelope and key
// ring as HRIS PII (lib/hris-pii.ts: v1 = DATA_ENCRYPTION_KEY, v2+ from
// HRIS_PII_KEYS, active = HRIS_PII_ACTIVE_KEY_VERSION; legend-snhxw), with its
// own AAD namespace so a payroll ciphertext can never be opened as an employee
// field or moved to another row, table, field or tenant. The row's
// `pii_key_version` says which key sealed it; worker/hris-pii-reseal.job.ts
// moves old rows to the active version after a rotation.
import { idr, type Idr } from "@starter/shared/core";
import { payrollGrossEnvelopeSchema } from "./payroll-gross-envelope.ts";
import {
  HRIS_PII_KEY_VERSION,
  hrisPiiRingKey,
  isHrisPiiKeyVersionSupported,
} from "./hris-pii.ts";
import {
  openSecret,
  openSecretWithKey,
  sealSecretBaseKey,
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
    | "payroll_rapel_items"
    | "payslip_bank_snapshots"
    | "payroll_run_results"
    | "payroll_disbursement_items"
    | "payroll_disbursement_batches";
  readonly rowId: string;
  readonly field:
    | "amount"
    | "calculation"
    | "bankSnapshot"
    | "result"
    | "fee"
    | "totals"
    | "inquiryName";
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

// Legacy envelopes start with the secret envelope version byte 1. A revisioned
// gross calculation starts with 2, UInt32BE revision, 16 raw run UUID bytes,
// then the unchanged AES-GCM envelope. Both clear metadata fields are AAD.
const REVISION_ENVELOPE = 2;
const REVISION_HEADER_BYTES = 21;
const MIN_SECRET_BYTES = 29;
type GrossMetadata = { payrollRunId: string; rapelAllocationRevision: number };

function grossMetadata(value: string): GrossMetadata | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("rapelAllocationRevision" in decoded)
  )
    return undefined;
  const parsed = payrollGrossEnvelopeSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.payrollRunId === undefined ||
    parsed.data.rapelAllocationRevision === undefined
  )
    throw new Error("Malformed revisioned payroll calculation");
  return {
    payrollRunId: parsed.data.payrollRunId.toLowerCase(),
    rapelAllocationRevision: parsed.data.rapelAllocationRevision,
  };
}
function calculationBinding(binding: PayrollSealBinding) {
  return binding.table === "payslips" && binding.field === "calculation";
}
function metadataAad(
  binding: PayrollSealBinding,
  keyVersion: number,
  metadata?: GrossMetadata,
) {
  const aad = aadOf(binding, keyVersion);
  return metadata
    ? `${aad}:run:${metadata.payrollRunId}:rapel:${metadata.rapelAllocationRevision}`
    : aad;
}
function revisionHeader(metadata: GrossMetadata): Buffer {
  const header = Buffer.alloc(REVISION_HEADER_BYTES);
  header[0] = REVISION_ENVELOPE;
  header.writeUInt32BE(metadata.rapelAllocationRevision, 1);
  Buffer.from(metadata.payrollRunId.replaceAll("-", ""), "hex").copy(header, 5);
  return header;
}
function readRevisionHeader(envelope: Buffer): GrossMetadata {
  if (envelope.length < REVISION_HEADER_BYTES + MIN_SECRET_BYTES)
    throw new Error("Revisioned payroll calculation is truncated");
  const hex = envelope.subarray(5, 21).toString("hex");
  return {
    payrollRunId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    rapelAllocationRevision: envelope.readUInt32BE(1),
  };
}

/** Seals a string for its row; key rotation preserves revision metadata. */
export function sealPayrollValue(
  value: string,
  binding: PayrollSealBinding,
  keyVersion: number = PAYROLL_SEAL_KEY_VERSION,
): Buffer {
  const metadata = calculationBinding(binding)
    ? grossMetadata(value)
    : undefined;
  const aad = metadataAad(binding, keyVersion, metadata);
  const key = hrisPiiRingKey(keyVersion);
  const envelope = Buffer.from(
    key ? sealSecretWithKey(key, value, aad) : sealSecretBaseKey(value, aad),
    "base64",
  );
  return metadata
    ? Buffer.concat([revisionHeader(metadata), envelope])
    : envelope;
}

/** Opens a sealed column; authenticates revision/run before returning money. */
export function openPayrollValue(
  sealed: Buffer | Uint8Array,
  binding: PayrollSealBinding,
  keyVersion: number,
): string {
  const envelope = Buffer.from(sealed);
  const version = envelope[0];
  let metadata: GrossMetadata | undefined;
  let secret = envelope;
  if (version === REVISION_ENVELOPE) {
    if (!calculationBinding(binding))
      throw new Error("Revisioned payroll seal needs a calculation binding");
    metadata = readRevisionHeader(envelope);
    secret = envelope.subarray(REVISION_HEADER_BYTES);
  } else if (version !== 1) {
    throw new Error("Unknown payroll seal version");
  }
  const aad = metadataAad(binding, keyVersion, metadata);
  const key = hrisPiiRingKey(keyVersion);
  const encoded = secret.toString("base64");
  const value = key
    ? openSecretWithKey(key, encoded, aad)
    : openSecret(encoded, aad);
  if (metadata) {
    const actual = grossMetadata(value);
    if (
      !actual ||
      actual.payrollRunId !== metadata.payrollRunId ||
      actual.rapelAllocationRevision !== metadata.rapelAllocationRevision
    )
      throw new Error(
        "Payroll calculation metadata does not match its authenticated header",
      );
  }
  return value;
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
