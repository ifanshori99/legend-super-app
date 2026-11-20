// Employee master data, organisation structure and employment contracts
// (PRD v1.7 §3 Kelompok D 26 "Data Karyawan & Organisasi", §6 H tables
// `org_units`, `positions`, `employees`, `employment_contracts`,
// `employee_documents`; F24, HR-01, HR-03).
//
// PII is separated from master data on purpose: `employeeSchema` carries no
// personal data at all, so employee lists and org charts can be served without
// a PII permission. The masked PII fields live in `employeePiiSchema` and are
// served by a separate endpoint guarded with `HRIS_PII_FIELDS`.

import {
  z,
  clientInputSchema,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  decimal4Schema,
  parseDecimal4,
  CoreError,
} from "../core/index.ts";
import {
  employeeIdSchema,
  orgUnitIdSchema,
  positionIdSchema,
  positionGradeIdSchema,
  employmentContractIdSchema,
  employeeDocumentIdSchema,
} from "./ids.ts";
import type { EmployeeId } from "./ids.ts";
import { HRIS_BANK_CODES } from "./bank-codes.ts";
import { maskedPiiValueSchema } from "./pii.ts";
import { taxSchemeSchema } from "./payroll/components.ts";

const name = z.string().min(1).max(150);
const code = z.string().min(1).max(30);
const nonnegativeDecimal = decimal4Schema.refine(
  (value) => parseDecimal4(value) >= 0n,
  "Must not be negative",
);
const row = { id: uuidSchema, tenantId: tenantIdSchema };

// ---- Organisation --------------------------------------------------------

/** PRD §6 H `org_units`: name, parent_id (self-referencing tree). */
export const orgUnitSchema = z.strictObject({
  ...row,
  id: orgUnitIdSchema,
  parentId: orgUnitIdSchema.nullable(),
  code,
  name,
  isActive: z.boolean(),
});
export type OrgUnit = z.infer<typeof orgUnitSchema>;

/** Grade of a position: the "grade" of PRD §6 H `positions`. */
export const positionGradeSchema = z.strictObject({
  ...row,
  id: positionGradeIdSchema,
  code,
  name,
  /** 1 = lowest. Used for approval limits and reporting, never for pay by itself. */
  level: z.number().int().min(1).max(99),
});
export type PositionGrade = z.infer<typeof positionGradeSchema>;

/**
 * PRD §6 H `positions`: name, grade, service_charge_points. `points` feeds the
 * service-charge split that the payroll contract (bead legend-zjwa) owns; it is
 * a quantity, not money, so NUMERIC(14,4).
 */
export const positionSchema = z.strictObject({
  ...row,
  id: positionIdSchema,
  name,
  gradeId: positionGradeIdSchema.nullable(),
  orgUnitId: orgUnitIdSchema.nullable(),
  serviceChargePoints: nonnegativeDecimal,
  isActive: z.boolean(),
});
export type Position = z.infer<typeof positionSchema>;

export const orgStructureSchema = z
  .strictObject({
    orgUnits: z.array(orgUnitSchema),
    grades: z.array(positionGradeSchema),
    positions: z.array(positionSchema),
  })
  .superRefine((structure, ctx) => {
    const unitIds = new Set(structure.orgUnits.map((unit) => unit.id));
    const gradeIds = new Set(structure.grades.map((grade) => grade.id));
    for (const unit of structure.orgUnits)
      if (unit.parentId !== null && !unitIds.has(unit.parentId))
        ctx.addIssue({
          code: "custom",
          path: ["orgUnits"],
          message: `Org unit ${unit.id} names an unknown parent`,
        });
    for (const position of structure.positions)
      if (position.gradeId !== null && !gradeIds.has(position.gradeId))
        ctx.addIssue({
          code: "custom",
          path: ["positions"],
          message: `Position ${position.id} names an unknown grade`,
        });
  });
export type OrgStructure = z.infer<typeof orgStructureSchema>;

// ---- Employee ------------------------------------------------------------

/** PRD §6 H `employees.employment_type`. */
export const employmentTypeSchema = z.enum([
  "pkwtt",
  "pkwt",
  "daily",
  "intern",
]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

/** PRD §6 H `employees.status`. */
export const employeeStatusSchema = z.enum([
  "onboarding",
  "active",
  "suspended",
  "resigned",
  "terminated",
]);
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>;

/**
 * PTKP status (PP 58/2023 vocabulary: TK = tidak kawin, K = kawin, K/I =
 * kawin dan penghasilan istri digabung). The TER tables themselves belong to
 * the payroll contract (bead legend-zjwa); this column is on `employees`.
 */
export const ptkpStatusSchema = z.enum([
  "TK/0",
  "TK/1",
  "TK/2",
  "TK/3",
  "K/0",
  "K/1",
  "K/2",
  "K/3",
  "K/I/0",
  "K/I/1",
  "K/I/2",
  "K/I/3",
]);
export type PtkpStatus = z.infer<typeof ptkpStatusSchema>;

/**
 * Employee master data. Contains no PII: encrypted personal fields are in
 * `employeePiiSchema`, served separately (HR-03).
 */
export const employeeShape = {
  ...row,
  id: employeeIdSchema,
  /** Login account; null for an employee who never signs in (PRD F30 opt-in). */
  userId: userIdSchema.nullable(),
  /** Employer legal entity (§6 H `legal_entity_id`); owned by the org schema. */
  legalEntityId: uuidSchema.nullable(),
  /** Unique per tenant (PRD §6 H `employee_no` VARCHAR(30)). */
  employeeNo: z
    .string()
    .min(2)
    .max(30)
    .regex(
      /^[A-Z0-9][A-Z0-9-]*$/,
      "Employee numbers are uppercase letters, digits and hyphens",
    ),
  fullName: name,
  positionId: positionIdSchema.nullable(),
  orgUnitId: orgUnitIdSchema.nullable(),
  managerId: employeeIdSchema.nullable(),
  homeOutletId: outletIdSchema,
  employmentType: employmentTypeSchema,
  joinDate: businessDateSchema,
  endDate: businessDateSchema.nullable(),
  ptkpStatus: ptkpStatusSchema.nullable(),
  status: employeeStatusSchema,
} as const;

const employeeBaseSchema = z.strictObject(employeeShape);
type EmployeeBase = z.infer<typeof employeeBaseSchema>;

function checkEmployeeDates(
  employee: EmployeeBase,
  ctx: z.RefinementCtx,
): void {
  if (employee.managerId === employee.id)
    ctx.addIssue({
      code: "custom",
      path: ["managerId"],
      message: "An employee cannot be their own manager",
    });
  if (employee.endDate !== null && employee.endDate < employee.joinDate)
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "End date cannot precede join date",
    });
}

export const employeeSchema =
  employeeBaseSchema.superRefine(checkEmployeeDates);
export type Employee = z.infer<typeof employeeSchema>;

/** Per-employee actions belong to the detail response, not the directory. */
export const employeeProfileSchema = employeeBaseSchema
  .extend({ canChangeManager: z.boolean() })
  .superRefine(checkEmployeeDates);
export type EmployeeProfile = z.infer<typeof employeeProfileSchema>;

/**
 * Masked personal data (HR-03). Only ever `{ masked, keyVersion }`; raw values
 * are write-only input and ciphertext never leaves Postgres.
 */
export const employeePiiSchema = z
  .strictObject({
    nik: maskedPiiValueSchema.nullable(),
    npwp: maskedPiiValueSchema.nullable(),
    bpjsKesNo: maskedPiiValueSchema.nullable(),
    bpjsTkNo: maskedPiiValueSchema.nullable(),
    bankAccount: maskedPiiValueSchema.nullable(),
    /** BI bank code of `bankAccount`; not a secret, shown with the account. */
    bankCode: z.enum(HRIS_BANK_CODES).nullable().default(null),
    emergencyContactName: maskedPiiValueSchema.nullable(),
    emergencyContactPhone: maskedPiiValueSchema.nullable(),
  })
  .strict();
export type EmployeePii = z.infer<typeof employeePiiSchema>;

/** Detail response: master data plus masked PII (separate guarded endpoint). */
export const employeeDetailSchema = z
  .strictObject({
    ...employeeShape,
    pii: employeePiiSchema,
  })
  .superRefine(checkEmployeeDates);
export type EmployeeDetail = z.infer<typeof employeeDetailSchema>;

/** Write-only profile input; the service encrypts each value before storing. */
export const updateEmployeePiiInputSchema = clientInputSchema({
  nik: z.string().min(16).max(32).optional(),
  npwp: z.string().min(15).max(20).optional(),
  bpjsKesNo: z.string().min(8).max(20).optional(),
  bpjsTkNo: z.string().min(8).max(20).optional(),
  bankAccount: z.string().min(6).max(34).optional(),
  /** Plain column (not sealed); `null` clears it. A bank account without a code is allowed (cash fallback). */
  bankCode: z.enum(HRIS_BANK_CODES).nullable().optional(),
  emergencyContactName: z.string().min(1).max(150).optional(),
  emergencyContactPhone: z.string().min(6).max(20).optional(),
});
export type UpdateEmployeePiiInput = z.infer<
  typeof updateEmployeePiiInputSchema
>;

/** HR / GM brand sets (or clears with null) the direct manager of one employee. */
/**
 * HR (with payroll access) sets the PTKP status with the day it is in force
 * (bead 1223, PMK 168/2023): the start of the running tax year (1 January, or
 * the join date) to correct a wrong entry, or today for a change that applies
 * from the next tax year. Payslips already computed are never recomputed.
 */
export const correctEmployeePtkpInputSchema = clientInputSchema({
  ptkpStatus: ptkpStatusSchema,
  effectiveFrom: businessDateSchema,
  reason: z.string().trim().min(5).max(500),
});
export type CorrectEmployeePtkpInput = z.infer<
  typeof correctEmployeePtkpInputSchema
>;

export const changeEmployeeManagerInputSchema = clientInputSchema({
  managerId: employeeIdSchema.nullable(),
  reason: z.string().trim().min(1).max(200).optional(),
});
export type ChangeEmployeeManagerInput = z.infer<
  typeof changeEmployeeManagerInputSchema
>;

const employeeStatusTransitions: Partial<
  Record<
    EmployeeStatus,
    Partial<
      Record<
        "activate" | "suspend" | "reinstate" | "resign" | "terminate",
        EmployeeStatus
      >
    >
  >
> = {
  onboarding: { activate: "active", terminate: "terminated" },
  active: {
    suspend: "suspended",
    resign: "resigned",
    terminate: "terminated",
  },
  suspended: {
    reinstate: "active",
    resign: "resigned",
    terminate: "terminated",
  },
};
export type EmployeeStatusAction =
  "activate" | "suspend" | "reinstate" | "resign" | "terminate";

/** PRD §6 H `employees.status` lifecycle; terminal states are permanent. */
export function transitionEmployeeStatus(
  status: EmployeeStatus,
  action: EmployeeStatusAction,
): EmployeeStatus {
  const next = employeeStatusTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi status karyawan tidak valid: ${status} → ${action}.`,
    );
  return next;
}

/** True when the employee can clock in and receive new shifts. */
export function isEmployeeActive(status: EmployeeStatus): boolean {
  return status === "active";
}

// ---- Employment contracts ------------------------------------------------

export const employmentContractStatusSchema = z.enum([
  "draft",
  "active",
  "expired",
  "renewed",
  "terminated",
]);
export type EmploymentContractStatus = z.infer<
  typeof employmentContractStatusSchema
>;

/**
 * PRD §6 H `employment_contracts`: type, dates, encrypted salary snapshot,
 * file. `renewedFromId` links a renewal chain; `reminderDaysBefore` drives the
 * expiry reminder (F24 "pengingat sebelum kontrak habis") and is required, so
 * no lead time is invented in code.
 */
export const employmentContractSchema = z
  .strictObject({
    ...row,
    id: employmentContractIdSchema,
    employeeId: employeeIdSchema,
    type: employmentTypeSchema,
    /**
     * PPh 21 scheme of the agreement (gross / gross_up / net). A period with
     * no taxable line of its own (employer BPJS in an unpaid month) follows
     * it (pph21.ts `contractTaxScheme`, bead legend-rhq5).
     */
    taxScheme: taxSchemeSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema.nullable(),
    renewedFromId: employmentContractIdSchema.nullable(),
    /**
     * Encrypted `salary_snapshot_encrypted`; masked on the wire (HR-03), null
     * for a viewer whose visibility is `hidden` (supervisor, owner).
     */
    salarySnapshot: maskedPiiValueSchema.nullable(),
    /** Short-lived signed URL of the private contract scan; the storage key stays server-side. */
    fileUrl: z.string().min(1).max(2048).nullable(),
    /** Reminder window before `endDate`; tenant configuration. */
    reminderDaysBefore: z.number().int().min(1).max(180),
    status: employmentContractStatusSchema,
  })
  .superRefine((contract, ctx) => {
    if (contract.endDate !== null && contract.endDate < contract.startDate)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Contract end date cannot precede its start date",
      });
    // PRD F24: PKWT is a fixed-term contract (it must end), PKWTT is permanent.
    if (contract.type === "pkwt" && contract.endDate === null)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "A PKWT contract requires an end date",
      });
    if (contract.type === "pkwtt" && contract.endDate !== null)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "A PKWTT contract is permanent and has no end date",
      });
    if (contract.renewedFromId === contract.id)
      ctx.addIssue({
        code: "custom",
        path: ["renewedFromId"],
        message: "A contract cannot renew itself",
      });
  });
export type EmploymentContract = z.infer<typeof employmentContractSchema>;

const contractTransitions: Partial<
  Record<
    EmploymentContractStatus,
    Partial<
      Record<
        "activate" | "expire" | "renew" | "terminate",
        EmploymentContractStatus
      >
    >
  >
> = {
  draft: { activate: "active", terminate: "terminated" },
  active: {
    expire: "expired",
    renew: "renewed",
    terminate: "terminated",
  },
  expired: { renew: "renewed" },
};
export type EmploymentContractAction =
  "activate" | "expire" | "renew" | "terminate";

/** Contract lifecycle (draft → active → expired/renewed/terminated). */
export function transitionEmploymentContract(
  status: EmploymentContractStatus,
  action: EmploymentContractAction,
): EmploymentContractStatus {
  const next = contractTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi kontrak tidak valid: ${status} → ${action}.`,
    );
  return next;
}

/**
 * True when a contract should raise its expiry reminder on `today`: it is
 * active, has an end date, and the end date falls inside the reminder window.
 */
export function isContractExpiryReminderDue(
  contract: Pick<
    EmploymentContract,
    "status" | "endDate" | "reminderDaysBefore"
  >,
  today: string,
): boolean {
  if (contract.status !== "active" || contract.endDate === null) return false;
  const day = 86_400_000;
  const daysLeft = Math.round(
    (Date.parse(`${contract.endDate}T00:00:00.000Z`) -
      Date.parse(`${today}T00:00:00.000Z`)) /
      day,
  );
  return daysLeft >= 0 && daysLeft <= contract.reminderDaysBefore;
}

// ---- Employee documents --------------------------------------------------

/** PRD §6 H `employee_documents.type` (KTP, NPWP, BPJS, contract, certificate). */
export const employeeDocumentTypeSchema = z.enum([
  "ktp",
  "npwp",
  "bpjs",
  "contract",
  "certificate",
  "education",
  "other",
]);
export type EmployeeDocumentType = z.infer<typeof employeeDocumentTypeSchema>;

/**
 * `file_key` points into the private bucket; the route returns a short-lived
 * signed `downloadUrl` instead of the key. `expiresOn` drives document
 * reminders (KTP, certificates).
 */
export const employeeDocumentSchema = z
  .strictObject({
    ...row,
    id: employeeDocumentIdSchema,
    employeeId: employeeIdSchema,
    type: employeeDocumentTypeSchema,
    /** Server-signed, short-lived URL; null when the API has not minted one. */
    downloadUrl: z.string().min(1).max(2048).nullable(),
    expiresOn: businessDateSchema.nullable(),
    uploadedAt: isoDateTimeSchema,
    verifiedBy: userIdSchema.nullable(),
    verifiedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((doc, ctx) => {
    if ((doc.verifiedBy === null) !== (doc.verifiedAt === null))
      ctx.addIssue({
        code: "custom",
        message: "Document verification needs both actor and time",
      });
  });
export type EmployeeDocument = z.infer<typeof employeeDocumentSchema>;

/** HR-01: documents an employee may list are their own. */
export function canReadEmployeeDocument(
  viewerEmployeeId: EmployeeId | null,
  documentEmployeeId: EmployeeId,
  hasHrPermission: boolean,
): boolean {
  if (hasHrPermission) return true;
  return (
    viewerEmployeeId !== null &&
    viewerEmployeeId.toLowerCase() === documentEmployeeId.toLowerCase()
  );
}
