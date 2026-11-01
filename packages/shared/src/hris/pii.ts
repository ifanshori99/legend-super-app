// Employee personal data (PRD v1.7 §3 Kelompok D "Profil Karyawan", §6 H,
// HR-01, HR-03).
//
// Rules encoded here, not in the UI:
// - HR-03: NIK, NPWP, BPJS, bank account and salary are encrypted at rest and
//   only HR/payroll roles see them. `HRIS_PII_FIELDS` records, per field, the
//   encrypted column, the HMAC blind index used for exact lookup, the masking
//   rule, the permission codes that may read it, and whether the owner sees
//   it. The database uses app-level AES-256-GCM (`app_aes_256_gcm`); document
//   and selfie bytes live in a private bucket with server-side encryption
//   (`private_bucket_sse`), not in Postgres.
// - HR-01: an employee may only see their own record. `canHrisViewEmployee`
//   and `hrisPiiVisibility` fail closed for a `self` viewer that names another
//   employee, so a direct API call or Tanya AI tool call gets `hidden`.
// - Wire format: PII never leaves the server in clear text. Every value is a
//   `MaskedPiiValue` (`masked` + `keyVersion`); the ciphertext stays in
//   Postgres. Editing a profile sends the new value write-only and the service
//   encrypts it before storing. Payroll bank files and tax exports are built
//   server-side from the encrypted columns, not from a client round-trip.
// - Masking stays consistent with the audit contract: every field name below
//   contains a key that `isSensitiveAuditKey` already redacts (nik, npwp, bank
//   account, salary/gaji, bpjs, emergency/contact), so an audit `before` /
//   `after` row can never carry these values even if a caller forgets a safe
//   list.

import { z } from "../core/index.ts";
import {
  tenantPermissionCodeSchema,
  type PermissionCode,
} from "../access/permissions.ts";
import { employeeIdSchema } from "./ids.ts";
import type { EmployeeId } from "./ids.ts";

/** `{ masked, keyVersion }`: the only form of a PII value that reaches a client. */
export const maskedPiiValueSchema = z
  .strictObject({
    /** e.g. "****4821", "b***@cafelegend.id"; never the raw value. */
    masked: z.string().min(1).max(64),
    /** Encryption key version at rest, for rotation metadata. */
    keyVersion: z.number().int().positive().safe(),
  })
  .strict();
export type MaskedPiiValue = z.infer<typeof maskedPiiValueSchema>;

/** How a value is reduced for its masked form. */
export const PII_MASK_RULES = ["last4", "redact", "email", "name"] as const;
export type PiiMaskRule = (typeof PII_MASK_RULES)[number];

const REDACTED = "******";

/**
 * Reduces a PII value to a display form. `last4` keeps the four trailing
 * alphanumerics (bank account, NIK, NPWP, BPJS), `email` keeps the first local
 * character and the domain, and `name` keeps the first word plus the next
 * initial. Anything too short to mask safely becomes a fixed redaction, never
 * the value itself.
 */
export function maskPiiValue(value: string, rule: PiiMaskRule): string {
  const text = value.trim();
  if (text.length === 0) return REDACTED;
  switch (rule) {
    case "redact":
      return REDACTED;
    case "last4": {
      const digits = text.replace(/[^0-9A-Za-z]/g, "");
      if (digits.length <= 4) return REDACTED;
      return `****${digits.slice(-4)}`;
    }
    case "email": {
      const at = text.lastIndexOf("@");
      if (at <= 0 || at === text.length - 1) return REDACTED;
      const domain = text.slice(at + 1);
      if (!domain.includes(".")) return REDACTED;
      return `${text[0]}***@${domain}`;
    }
    case "name": {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length === 0) return REDACTED;
      if (words.length === 1)
        return words[0].length <= 1 ? REDACTED : `${words[0][0]}***`;
      return `${words[0]} ${words[1][0]}***`;
    }
  }
}

/** Data classes HR-03 protects, plus the operational media the PRD stores privately. */
export const HRIS_PII_CLASSES = {
  identity: "NIK and other government identity numbers (KTP).",
  tax: "NPWP and PTKP tax profile.",
  social_security: "BPJS Kesehatan and BPJS Ketenagakerjaan numbers.",
  bank: "Payroll bank account.",
  salary: "Salary snapshot and contractual pay amounts.",
  contact: "Personal phone and email.",
  emergency_contact: "Emergency contact name and phone.",
  document: "Identity, contract and certificate files (private bucket).",
  attendance_photo: "Attendance selfie (reviewed by sampling, PRD F25).",
  health: "Sick-leave reason and medical certificate (PRD F29).",
} as const;
export type HrisPiiClass = keyof typeof HRIS_PII_CLASSES;

/** Where the value is protected. Postgres app encryption or private object storage. */
export const PII_ENCRYPTION_AT_REST = [
  "app_aes_256_gcm",
  "private_bucket_sse",
] as const;
export type PiiEncryptionAtRest = (typeof PII_ENCRYPTION_AT_REST)[number];

export type HrisPiiFieldDefinition = {
  /** Wire field that carries the masked value. */
  readonly field: string;
  /** Encrypted Postgres column (PRD §6 H `*_encrypted` BYTEA columns). */
  readonly column: string;
  /** HMAC-SHA256 blind index for exact lookup; null when the field is never queried by value. */
  readonly blindIndex: string | null;
  readonly piiClass: HrisPiiClass;
  readonly encryptionAtRest: PiiEncryptionAtRest;
  readonly maskRule: PiiMaskRule;
  /** Tenant permission codes that may read the masked value (access contract). */
  readonly readPermissions: readonly PermissionCode[];
  /** Self-service permission for the owner's own value; null = not self-service. */
  readonly selfPermission: PermissionCode | null;
};

/**
 * Every employee-related PII field the contract exposes, with its protection.
 * Names match the masked wire fields; columns match PRD §6 H.
 */
export const HRIS_PII_FIELDS = {
  employeeNik: {
    field: "nik",
    column: "nik_encrypted",
    blindIndex: "nik_hmac",
    piiClass: "identity",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: "self.profile.view",
  },
  employeeNpwp: {
    field: "npwp",
    column: "npwp_encrypted",
    blindIndex: "npwp_hmac",
    piiClass: "tax",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: "self.profile.view",
  },
  employeeBpjsKes: {
    field: "bpjsKesNo",
    column: "bpjs_kes_no_encrypted",
    blindIndex: "bpjs_kes_no_hmac",
    piiClass: "social_security",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: "self.profile.view",
  },
  employeeBpjsTk: {
    field: "bpjsTkNo",
    column: "bpjs_tk_no_encrypted",
    blindIndex: "bpjs_tk_no_hmac",
    piiClass: "social_security",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: "self.profile.view",
  },
  employeeBankAccount: {
    field: "bankAccount",
    column: "bank_account_encrypted",
    blindIndex: "bank_account_hmac",
    piiClass: "bank",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: "self.profile.view",
  },
  employeeEmergencyContactName: {
    field: "emergencyContactName",
    column: "emergency_contact_name_encrypted",
    blindIndex: null,
    piiClass: "emergency_contact",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "name",
    readPermissions: ["hr.employee.view"],
    selfPermission: "self.profile.view",
  },
  employeeEmergencyContactPhone: {
    field: "emergencyContactPhone",
    column: "emergency_contact_phone_encrypted",
    blindIndex: null,
    piiClass: "emergency_contact",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view"],
    selfPermission: "self.profile.view",
  },
  contractSalarySnapshot: {
    field: "salarySnapshot",
    column: "salary_snapshot_encrypted",
    blindIndex: null,
    piiClass: "salary",
    encryptionAtRest: "app_aes_256_gcm",
    maskRule: "last4",
    readPermissions: ["hr.employee.view", "payroll.view"],
    selfPermission: null,
  },
  contractFileUrl: {
    field: "fileUrl",
    column: "file_key",
    blindIndex: null,
    piiClass: "document",
    encryptionAtRest: "private_bucket_sse",
    maskRule: "redact",
    readPermissions: ["hr.employee.view"],
    selfPermission: null,
  },
  employeeDocumentFileUrl: {
    field: "downloadUrl",
    column: "file_key",
    blindIndex: null,
    piiClass: "document",
    encryptionAtRest: "private_bucket_sse",
    maskRule: "redact",
    readPermissions: ["hr.employee.view"],
    selfPermission: "self.profile.view",
  },
  attendancePhotoUrl: {
    field: "photoUrl",
    column: "photo_key",
    blindIndex: null,
    piiClass: "attendance_photo",
    encryptionAtRest: "private_bucket_sse",
    maskRule: "redact",
    readPermissions: ["hr.attendance.manage"],
    selfPermission: "self.attendance.clock",
  },
  leaveAttachmentUrl: {
    field: "attachmentUrl",
    column: "attachment_key",
    blindIndex: null,
    piiClass: "health",
    encryptionAtRest: "private_bucket_sse",
    maskRule: "redact",
    readPermissions: ["hr.employee.view", "hr.leave.approve"],
    selfPermission: "self.leave.request",
  },
} as const satisfies Record<string, HrisPiiFieldDefinition>;
export type HrisPiiFieldName = keyof typeof HRIS_PII_FIELDS;

/** True when a Postgres column holds employee PII and must be encrypted/private. */
export function isHrisPiiColumn(column: string): boolean {
  return Object.values(HRIS_PII_FIELDS).some(
    (entry) => entry.column === column,
  );
}

// ---- Who may see what -----------------------------------------------------

/** Viewer kinds the API resolves from the session (never from the client). */
export const HRIS_VIEWER_KINDS = [
  "self",
  "supervisor",
  "hr",
  "payroll",
  "owner",
  "system",
] as const;
export type HrisViewerKind = (typeof HRIS_VIEWER_KINDS)[number];

/** What a viewer gets for one PII field. */
export const HRIS_PII_VISIBILITIES = ["full", "masked", "hidden"] as const;
export type HrisPiiVisibility = (typeof HRIS_PII_VISIBILITIES)[number];

/**
 * Server-resolved viewer. `employeeId` is the viewer's own employee row, null
 * for an account without one (owner, finance, platform staff).
 */
export const hrisViewerSchema = z
  .strictObject({
    kind: z.enum(HRIS_VIEWER_KINDS),
    employeeId: employeeIdSchema.nullable(),
    /** Resolved tenant permission codes, as decided by the access contract. */
    permissions: z.array(tenantPermissionCodeSchema),
  })
  .strict();
export type HrisViewer = {
  readonly kind: HrisViewerKind;
  readonly employeeId: EmployeeId | null;
  readonly permissions: readonly string[];
};

const full: HrisPiiVisibility = "full";
const masked: HrisPiiVisibility = "masked";
const hidden: HrisPiiVisibility = "hidden";

/**
 * HR-03: salary, identity, tax, BPJS and bank data are `hidden` for every role
 * except HR and payroll. `self` is the owner's own record; supervisors see
 * attendance selfies (PRD F25 sampling review) but no payroll data.
 */
export const HRIS_PII_VISIBILITY: Record<
  HrisPiiClass,
  Record<HrisViewerKind, HrisPiiVisibility>
> = {
  identity: {
    self: masked,
    supervisor: hidden,
    hr: full,
    payroll: full,
    owner: hidden,
    system: full,
  },
  tax: {
    self: masked,
    supervisor: hidden,
    hr: full,
    payroll: full,
    owner: hidden,
    system: full,
  },
  social_security: {
    self: masked,
    supervisor: hidden,
    hr: full,
    payroll: full,
    owner: hidden,
    system: full,
  },
  bank: {
    self: masked,
    supervisor: hidden,
    hr: full,
    payroll: full,
    owner: hidden,
    system: full,
  },
  salary: {
    self: masked,
    supervisor: hidden,
    hr: full,
    payroll: full,
    owner: hidden,
    system: full,
  },
  contact: {
    self: full,
    supervisor: masked,
    hr: full,
    payroll: masked,
    owner: masked,
    system: full,
  },
  emergency_contact: {
    self: full,
    supervisor: hidden,
    hr: full,
    payroll: hidden,
    owner: hidden,
    system: full,
  },
  document: {
    self: full,
    supervisor: hidden,
    hr: full,
    payroll: hidden,
    owner: hidden,
    system: full,
  },
  attendance_photo: {
    self: full,
    supervisor: full,
    hr: full,
    payroll: hidden,
    owner: hidden,
    system: full,
  },
  health: {
    self: full,
    supervisor: hidden,
    hr: full,
    payroll: hidden,
    owner: hidden,
    system: full,
  },
};

/**
 * HR-01: a `self` viewer may only reach their own employee record; every
 * direct API or Tanya AI call runs through this check. A viewer without an
 * employee row can never satisfy `self`.
 */
export function canHrisViewEmployee(
  viewer: HrisViewer,
  subjectEmployeeId: EmployeeId | string,
): boolean {
  if (viewer.kind === "self")
    return (
      viewer.employeeId !== null &&
      viewer.employeeId.toLowerCase() === subjectEmployeeId.toLowerCase()
    );
  return true;
}

/**
 * Visibility of one PII class for one subject. HR and payroll keep their
 * rights when reading their own row; everyone else gets the `self` column only
 * for their own record, and `hidden` otherwise (HR-01).
 */
export function hrisPiiVisibility(
  viewer: HrisViewer,
  subjectEmployeeId: EmployeeId | string,
  piiClass: HrisPiiClass,
): HrisPiiVisibility {
  if (viewer.kind === "self" && !canHrisViewEmployee(viewer, subjectEmployeeId))
    return "hidden";
  const column: HrisViewerKind =
    viewer.kind === "hr" ||
    viewer.kind === "payroll" ||
    viewer.kind === "system"
      ? viewer.kind
      : viewer.employeeId !== null &&
          viewer.employeeId.toLowerCase() === subjectEmployeeId.toLowerCase()
        ? "self"
        : viewer.kind;
  return HRIS_PII_VISIBILITY[piiClass][column];
}

/** Permission codes that grant reading a PII class, for the API route guard. */
export function hrisPiiReadPermissions(
  piiClass: HrisPiiClass,
): readonly PermissionCode[] {
  const codes = new Set<PermissionCode>();
  for (const entry of Object.values(HRIS_PII_FIELDS))
    if (entry.piiClass === piiClass)
      for (const code of entry.readPermissions) codes.add(code);
  return [...codes];
}

/** Metadata of one field; throws for an unknown field name (fail closed). */
export function hrisPiiField(name: HrisPiiFieldName): HrisPiiFieldDefinition {
  return HRIS_PII_FIELDS[name];
}

/** Tenant-scoped PII subject: employee rows always belong to one tenant. */
export const hrisPiiSubjectSchema = z.strictObject({
  tenantId: z.uuid().toLowerCase(),
  employeeId: employeeIdSchema,
});
export type HrisPiiSubject = z.infer<typeof hrisPiiSubjectSchema>;
