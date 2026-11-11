// HRIS master data (PRD v1.7 §3 Kelompok D F26 "Data Karyawan & Organisasi",
// §6 H `employees`, `org_units` / `positions`, `employment_contracts`,
// `employee_documents`; §2 Keamanan "enkripsi di tingkat aplikasi ... blind
// index (HMAC)"; HR-01, HR-03, HR-04; bead legend-qe1z).
//
// Contract: `@starter/shared/hris` (organization.ts, pii.ts). Column names of
// the encrypted fields follow `HRIS_PII_FIELDS[...].column` / `.blindIndex`.
//
// - PII (NIK, NPWP, BPJS Kesehatan / Ketenagakerjaan, payroll bank account,
//   emergency contact, contract salary snapshot) is sealed in the API with
//   AES-256-GCM (lib/secrets.ts via lib/hris-pii.ts) and stored as BYTEA. The
//   AAD binds every value to tenant + row + field, so ciphertext copied to
//   another row or tenant fails to open. `pii_key_version` records the key
//   version the row was sealed with (rotation metadata, contract `keyVersion`).
// - `*_hmac` is the HMAC-SHA256 blind index (tenant-separated purpose), the
//   only way to look a value up or enforce uniqueness without plaintext.
//   Identity numbers are unique per tenant; the bank account is lookup only.
// - Employees, org structure, contracts and documents are tenant-owned master
//   data: tenant RLS on every table (hris.custom.sql). `employees` has a
//   `home_outlet_id` placement, not an operational `outlet_id`, so outlet reach
//   is enforced by the service (contracts.md "TEN-03 outlet isolation layers",
//   like tables with a nullable outlet_id), not by `outlet_isolation`.
// - Documents and contract scans live in the private bucket
//   (`core_storage_objects`); only the object id is stored here and the route
//   hands out a short-lived signed URL, never the storage key.
// - Composite (tenant_id, id) foreign keys keep every reference inside one
//   tenant.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  EmployeeDocumentType,
  EmployeeStatus,
  EmploymentContractStatus,
  EmploymentType,
  PtkpStatus,
} from "@starter/shared/hris";
import type { UserId } from "@starter/shared/core";
import type { TaxScheme } from "@starter/shared/hris/payroll";
import { businessDate, decimal4Column, tenantIdColumn } from "../columns.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";
import { coreStorageObjects } from "./core-storage.ts";
import { user } from "./user.ts";

/** Sealed envelope bytes (version | nonce | tag | ciphertext). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

const HMAC_FORMAT = "'^[a-f0-9]{64}$'";

// ------------------------------------------------------------ organisation

/** PRD §6 H `org_units`: name, parent_id (self-referencing tree). */
export const orgUnits = pgTable(
  "org_units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    parentId: uuid("parent_id"),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("org_units_tenant_id_id_key").on(table.tenantId, table.id),
    unique("org_units_tenant_code_key").on(table.tenantId, table.code),
    foreignKey({
      name: "org_units_parent_fk",
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    index("org_units_tenant_parent_idx").on(table.tenantId, table.parentId),
    check(
      "org_units_parent_check",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
    check(
      "org_units_text_check",
      sql`length(${table.code}) > 0 AND length(${table.name}) > 0`,
    ),
  ],
);

/** Grade of a position (the "grade" of PRD §6 H `positions`). */
export const positionGrades = pgTable(
  "position_grades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    /** 1 = lowest (contract positionGradeSchema.level). */
    level: smallint("level").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("position_grades_tenant_id_id_key").on(table.tenantId, table.id),
    unique("position_grades_tenant_code_key").on(table.tenantId, table.code),
    check("position_grades_level_check", sql`${table.level} BETWEEN 1 AND 99`),
    check(
      "position_grades_text_check",
      sql`length(${table.code}) > 0 AND length(${table.name}) > 0`,
    ),
  ],
);

/** PRD §6 H `positions`: name, grade, service_charge_points. */
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    gradeId: uuid("grade_id"),
    orgUnitId: uuid("org_unit_id"),
    /** Quantity, not money: NUMERIC(14,4) (contract serviceChargePoints). */
    serviceChargePoints: decimal4Column("service_charge_points")
      .notNull()
      .default(sql`0`),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("positions_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "positions_grade_fk",
      columns: [table.tenantId, table.gradeId],
      foreignColumns: [positionGrades.tenantId, positionGrades.id],
    }),
    foreignKey({
      name: "positions_org_unit_fk",
      columns: [table.tenantId, table.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    index("positions_tenant_org_unit_idx").on(table.tenantId, table.orgUnitId),
    check("positions_points_check", sql`${table.serviceChargePoints} >= 0`),
    check("positions_name_check", sql`length(${table.name}) > 0`),
  ],
);

// --------------------------------------------------------------- employees

/** PRD §6 H `employees` (T). PII columns are sealed BYTEA + HMAC blind index. */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Login account; null for an employee who never signs in. */
    userId: text("user_id")
      .$type<UserId>()
      .references(() => user.id),
    legalEntityId: uuid("legal_entity_id"),
    employeeNo: varchar("employee_no", { length: 30 }).notNull(),
    fullName: varchar("full_name", { length: 150 }).notNull(),
    positionId: uuid("position_id"),
    orgUnitId: uuid("org_unit_id"),
    managerId: uuid("manager_id"),
    homeOutletId: uuid("home_outlet_id").notNull(),
    employmentType: varchar("employment_type", { length: 20 })
      .$type<EmploymentType>()
      .notNull(),
    joinDate: businessDate("join_date").notNull(),
    endDate: businessDate("end_date"),
    ptkpStatus: varchar("ptkp_status", { length: 10 }).$type<PtkpStatus>(),
    status: varchar("status", { length: 20 })
      .$type<EmployeeStatus>()
      .notNull()
      .default("onboarding"),

    // ---- HR-03 encrypted personal data (HRIS_PII_FIELDS columns) ----
    nikEncrypted: bytea("nik_encrypted"),
    nikHmac: varchar("nik_hmac", { length: 64 }),
    npwpEncrypted: bytea("npwp_encrypted"),
    npwpHmac: varchar("npwp_hmac", { length: 64 }),
    bpjsKesNoEncrypted: bytea("bpjs_kes_no_encrypted"),
    bpjsKesNoHmac: varchar("bpjs_kes_no_hmac", { length: 64 }),
    bpjsTkNoEncrypted: bytea("bpjs_tk_no_encrypted"),
    bpjsTkNoHmac: varchar("bpjs_tk_no_hmac", { length: 64 }),
    bankAccountEncrypted: bytea("bank_account_encrypted"),
    bankAccountHmac: varchar("bank_account_hmac", { length: 64 }),
    emergencyContactNameEncrypted: bytea("emergency_contact_name_encrypted"),
    emergencyContactPhoneEncrypted: bytea("emergency_contact_phone_encrypted"),
    /** Key version every sealed column of this row was written with. */
    piiKeyVersion: smallint("pii_key_version").notNull().default(1),
    /** Blind-index key version of every `*_hmac` column of this row
     * (lib/blind-index.ts, legend-n039). Rows before 0265 are version 1. */
    blindIndexVersion: smallint("blind_index_version").notNull().default(1),

    createdBy: text("created_by").$type<UserId>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("employees_tenant_id_id_key").on(table.tenantId, table.id),
    unique("employees_tenant_employee_no_key").on(
      table.tenantId,
      table.employeeNo,
    ),
    // One employee row per login account inside a tenant (GET /api/hris/me).
    uniqueIndex("employees_tenant_user_key")
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    // §2: uniqueness through the blind index, never through plaintext.
    uniqueIndex("employees_tenant_nik_hmac_key")
      .on(table.tenantId, table.nikHmac)
      .where(sql`${table.nikHmac} IS NOT NULL`),
    uniqueIndex("employees_tenant_npwp_hmac_key")
      .on(table.tenantId, table.npwpHmac)
      .where(sql`${table.npwpHmac} IS NOT NULL`),
    uniqueIndex("employees_tenant_bpjs_kes_no_hmac_key")
      .on(table.tenantId, table.bpjsKesNoHmac)
      .where(sql`${table.bpjsKesNoHmac} IS NOT NULL`),
    uniqueIndex("employees_tenant_bpjs_tk_no_hmac_key")
      .on(table.tenantId, table.bpjsTkNoHmac)
      .where(sql`${table.bpjsTkNoHmac} IS NOT NULL`),
    // A payroll account may legitimately be shared; lookup only.
    index("employees_tenant_bank_account_hmac_idx")
      .on(table.tenantId, table.bankAccountHmac)
      .where(sql`${table.bankAccountHmac} IS NOT NULL`),
    index("employees_tenant_status_idx").on(table.tenantId, table.status),
    index("employees_tenant_home_outlet_idx").on(
      table.tenantId,
      table.homeOutletId,
      table.employeeNo,
    ),
    foreignKey({
      name: "employees_home_outlet_fk",
      columns: [table.tenantId, table.homeOutletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "employees_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "employees_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }),
    foreignKey({
      name: "employees_org_unit_fk",
      columns: [table.tenantId, table.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    foreignKey({
      name: "employees_manager_fk",
      columns: [table.tenantId, table.managerId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check(
      "employees_employment_type_check",
      sql`${table.employmentType} IN ('pkwtt', 'pkwt', 'daily', 'intern')`,
    ),
    check(
      "employees_status_check",
      sql`${table.status} IN ('onboarding', 'active', 'suspended', 'resigned', 'terminated')`,
    ),
    check(
      "employees_ptkp_status_check",
      sql`${table.ptkpStatus} IS NULL OR ${table.ptkpStatus} IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3', 'K/I/0', 'K/I/1', 'K/I/2', 'K/I/3')`,
    ),
    check(
      "employees_employee_no_check",
      sql`${table.employeeNo} ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'`,
    ),
    check("employees_full_name_check", sql`length(${table.fullName}) > 0`),
    check(
      "employees_dates_check",
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.joinDate}`,
    ),
    check(
      "employees_manager_check",
      sql`${table.managerId} IS NULL OR ${table.managerId} <> ${table.id}`,
    ),
    check("employees_pii_key_version_check", sql`${table.piiKeyVersion} > 0`),
    // A sealed value always travels with its blind index, and vice versa.
    check(
      "employees_nik_pair_check",
      sql`(${table.nikEncrypted} IS NULL) = (${table.nikHmac} IS NULL) AND (${table.nikHmac} IS NULL OR ${table.nikHmac} ~ ${sql.raw(HMAC_FORMAT)})`,
    ),
    check(
      "employees_npwp_pair_check",
      sql`(${table.npwpEncrypted} IS NULL) = (${table.npwpHmac} IS NULL) AND (${table.npwpHmac} IS NULL OR ${table.npwpHmac} ~ ${sql.raw(HMAC_FORMAT)})`,
    ),
    check(
      "employees_bpjs_kes_no_pair_check",
      sql`(${table.bpjsKesNoEncrypted} IS NULL) = (${table.bpjsKesNoHmac} IS NULL) AND (${table.bpjsKesNoHmac} IS NULL OR ${table.bpjsKesNoHmac} ~ ${sql.raw(HMAC_FORMAT)})`,
    ),
    check(
      "employees_bpjs_tk_no_pair_check",
      sql`(${table.bpjsTkNoEncrypted} IS NULL) = (${table.bpjsTkNoHmac} IS NULL) AND (${table.bpjsTkNoHmac} IS NULL OR ${table.bpjsTkNoHmac} ~ ${sql.raw(HMAC_FORMAT)})`,
    ),
    check(
      "employees_bank_account_pair_check",
      sql`(${table.bankAccountEncrypted} IS NULL) = (${table.bankAccountHmac} IS NULL) AND (${table.bankAccountHmac} IS NULL OR ${table.bankAccountHmac} ~ ${sql.raw(HMAC_FORMAT)})`,
    ),
  ],
);

// ------------------------------------------------------ employment contracts

/** PRD §6 H `employment_contracts` (T): PKWT / PKWTT (F26 Kontrak Kerja). */
export const employmentContracts = pgTable(
  "employment_contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    type: varchar("type", { length: 20 }).$type<EmploymentType>().notNull(),
    /**
     * PPh 21 scheme of the agreement (bead legend-rhq5): pay with no line of
     * its own (employer BPJS in an unpaid month) follows it. Rows older than
     * migration 0103 were backfilled to 'gross'; new rows must state it.
     */
    taxScheme: varchar("tax_scheme", { length: 20 })
      .$type<TaxScheme>()
      .notNull(),
    startDate: businessDate("start_date").notNull(),
    endDate: businessDate("end_date"),
    renewedFromId: uuid("renewed_from_id"),
    /** HR-03 sealed whole-rupiah salary snapshot (contractSalarySnapshot). */
    salarySnapshotEncrypted: bytea("salary_snapshot_encrypted"),
    piiKeyVersion: smallint("pii_key_version").notNull().default(1),
    /** Contract scan in the private bucket (core_storage_objects). */
    fileObjectId: uuid("file_object_id"),
    reminderDaysBefore: integer("reminder_days_before").notNull(),
    status: varchar("status", { length: 20 })
      .$type<EmploymentContractStatus>()
      .notNull()
      .default("draft"),
    createdBy: text("created_by").$type<UserId>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("employment_contracts_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "employment_contracts_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "employment_contracts_renewed_from_fk",
      columns: [table.tenantId, table.renewedFromId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "employment_contracts_file_fk",
      columns: [table.tenantId, table.fileObjectId],
      foreignColumns: [coreStorageObjects.tenantId, coreStorageObjects.id],
    }),
    index("employment_contracts_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.startDate,
    ),
    index("employment_contracts_tenant_expiry_idx")
      .on(table.tenantId, table.status, table.endDate)
      .where(sql`${table.endDate} IS NOT NULL`),
    check(
      "employment_contracts_type_check",
      sql`${table.type} IN ('pkwtt', 'pkwt', 'daily', 'intern')`,
    ),
    check(
      "employment_contracts_tax_scheme_check",
      sql`${table.taxScheme} IN ('gross', 'gross_up', 'net')`,
    ),
    check(
      "employment_contracts_status_check",
      sql`${table.status} IN ('draft', 'active', 'expired', 'renewed', 'terminated')`,
    ),
    check(
      "employment_contracts_dates_check",
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
    // PRD F26: PKWT is fixed-term (must end), PKWTT is permanent.
    check(
      "employment_contracts_term_check",
      sql`(${table.type} <> 'pkwt' OR ${table.endDate} IS NOT NULL) AND (${table.type} <> 'pkwtt' OR ${table.endDate} IS NULL)`,
    ),
    check(
      "employment_contracts_renewal_check",
      sql`${table.renewedFromId} IS NULL OR ${table.renewedFromId} <> ${table.id}`,
    ),
    check(
      "employment_contracts_reminder_check",
      sql`${table.reminderDaysBefore} BETWEEN 1 AND 180`,
    ),
    check(
      "employment_contracts_pii_key_version_check",
      sql`${table.piiKeyVersion} > 0`,
    ),
  ],
);

// -------------------------------------------------------- employee documents

/** PRD §6 H `employee_documents` (T): KTP, NPWP, BPJS, contract, certificate. */
export const employeeDocuments = pgTable(
  "employee_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    type: varchar("type", { length: 20 })
      .$type<EmployeeDocumentType>()
      .notNull(),
    /** File in the private bucket; the API mints a signed URL per read. */
    storageObjectId: uuid("storage_object_id").notNull(),
    expiresOn: businessDate("expires_on"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    uploadedBy: text("uploaded_by").$type<UserId>(),
    verifiedBy: text("verified_by").$type<UserId>(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    unique("employee_documents_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "employee_documents_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "employee_documents_storage_fk",
      columns: [table.tenantId, table.storageObjectId],
      foreignColumns: [coreStorageObjects.tenantId, coreStorageObjects.id],
    }),
    index("employee_documents_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.uploadedAt,
    ),
    check(
      "employee_documents_type_check",
      sql`${table.type} IN ('ktp', 'npwp', 'bpjs', 'contract', 'certificate', 'education', 'other')`,
    ),
    check(
      "employee_documents_verified_check",
      sql`(${table.verifiedBy} IS NULL) = (${table.verifiedAt} IS NULL)`,
    ),
  ],
);

// ------------------------------------------------------------- idempotency

/**
 * Write idempotency for HRIS mutations (contract `idempotencyKey`). The
 * fingerprint is an HMAC of the request (it may contain PII, so never a bare
 * SHA-256), and the stored response is the masked DTO only.
 */
export const hrisIdempotency = pgTable(
  "hris_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 60 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").notNull(),
    createdAt,
  },
  (table) => [
    unique("hris_idempotency_tenant_key_key").on(table.tenantId, table.key),
    check(
      "hris_idempotency_fingerprint_check",
      sql`${table.fingerprint} ~ ${sql.raw(HMAC_FORMAT)}`,
    ),
  ],
);
