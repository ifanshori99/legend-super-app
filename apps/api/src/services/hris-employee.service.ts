// Employees and their encrypted personal data (PRD v1.7 §3 F26 "Profil
// Karyawan", "Kuota Karyawan"; §6 H `employees`; §2 enkripsi aplikasi;
// HR-01, HR-03, HR-04; bead legend-qe1z). Routes: routes/hris.routes.ts.
//
// - Master data (`employeeSchema`) carries no PII; lists need no PII right.
// - PII is served only by getEmployeePii, always as `{ masked, keyVersion }`
//   (contract: plaintext never leaves the server). Each value is decrypted in
//   process to compute its mask, and every decrypt is audited (R16 "audit log
//   akses data sensitif").
// - revealEmployeePii is the server-side plaintext right (payroll bank file,
//   tax export): HR (`hr.employee.manage`) or payroll (`payroll.run`) on the
//   employee's home outlet, visibility `full` for every field, a written
//   purpose, and an audit row — otherwise it refuses (fail closed). No route
//   exposes it.
// - HR-04: createEmployee serializes per tenant with an advisory transaction
//   lock, counts the seats in use and refuses with QUOTA_EXCEEDED at the plan
//   quota (`tenants.limits.maxActiveEmployees`).

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  idempotencyKeySchema,
  isOutletInScope,
  outletRefSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  employeeSchema,
  updateEmployeePiiInputSchema,
  updateEmployeePii as updateEmployeePiiEndpoint,
  listEmployees as listEmployeesEndpoint,
  type Employee,
  type EmployeeProfile,
  type EmployeePii,
  type EmployeeStatus,
  type MyHrisProfile,
  type UpdateEmployeePiiInput,
} from "@starter/shared/hris";
import { PlatformError, tenantLimitsSchema } from "@starter/shared/platform";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  employees,
  hrisIdempotency,
  orgUnits,
  positions,
} from "../db/schema/hris.ts";
import { legalEntities, outlets, tenants } from "../db/schema/platform-org.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { withTenant } from "../db/tenant.ts";
import { BLIND_INDEX_ACTIVE_VERSION } from "../lib/blind-index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  HRIS_EMPLOYEE_PII_FIELDS,
  HRIS_PII_KEY_VERSION,
  hrisBlindIndex,
  hrisBlindIndexCandidates,
  hrisFingerprintMatches,
  hrisPiiHasBlindIndex,
  hrisRequestFingerprint,
  maskHrisPii,
  normalizeHrisPii,
  openHrisPii,
  sealHrisPii,
  type HrisEmployeePiiField,
} from "../lib/hris-pii.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  hrisFieldVisibility,
  loadHrisAccess,
  mayChangeEmployeeManager,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";

type EmployeeRow = typeof employees.$inferSelect;
type ListEmployeesQuery = z.output<typeof listEmployeesEndpoint.query>;
type UpdatePiiBody = z.output<typeof updateEmployeePiiEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/**
 * HR-04 seats: every employee who is not resigned or terminated holds a seat
 * (onboarding and suspended included), so the quota cannot be bypassed by
 * parking people in a non-`active` status. Terminal states free the seat.
 */
export const HRIS_SEAT_STATUSES: readonly EmployeeStatus[] = [
  "onboarding",
  "active",
  "suspended",
];

/** Column pair of each sealed employee field. */
const PII_COLUMNS = {
  nik: { sealed: "nikEncrypted", hmac: "nikHmac" },
  npwp: { sealed: "npwpEncrypted", hmac: "npwpHmac" },
  bpjsKesNo: { sealed: "bpjsKesNoEncrypted", hmac: "bpjsKesNoHmac" },
  bpjsTkNo: { sealed: "bpjsTkNoEncrypted", hmac: "bpjsTkNoHmac" },
  bankAccount: { sealed: "bankAccountEncrypted", hmac: "bankAccountHmac" },
  emergencyContactName: {
    sealed: "emergencyContactNameEncrypted",
    hmac: null,
  },
  emergencyContactPhone: {
    sealed: "emergencyContactPhoneEncrypted",
    hmac: null,
  },
} as const satisfies Record<
  HrisEmployeePiiField,
  { sealed: keyof EmployeeRow; hmac: keyof EmployeeRow | null }
>;

/** Unique blind-index constraint → the field it protects (409 message). */
const UNIQUE_FIELD: Record<
  string,
  HrisEmployeePiiField | "employeeNo" | "userId"
> = {
  employees_tenant_nik_hmac_key: "nik",
  employees_tenant_npwp_hmac_key: "npwp",
  employees_tenant_bpjs_kes_no_hmac_key: "bpjsKesNo",
  employees_tenant_bpjs_tk_no_hmac_key: "bpjsTkNo",
  employees_tenant_employee_no_key: "employeeNo",
  employees_tenant_user_key: "userId",
};

function conflictError(field: string | undefined): HttpError {
  // Name the field, never the value.
  return new HttpError(
    409,
    "CONFLICT",
    field
      ? `${field} sudah terdaftar untuk karyawan lain di tenant ini.`
      : "Data karyawan bentrok dengan data lain.",
  );
}

function duplicateError(error: unknown): HttpError | null {
  const violation = uniqueViolation(error);
  if (!violation) return null;
  return conflictError(
    violation.constraint ? UNIQUE_FIELD[violation.constraint] : undefined,
  );
}

/** Fields whose blind index carries a unique index (bank account is lookup only). */
const UNIQUE_PII_FIELDS = ["nik", "npwp", "bpjsKesNo", "bpjsTkNo"] as const;

/**
 * Unique indexes are (tenant, digest): a version 1 row and a version 2 row of
 * the same value would not collide (legend-n039). Writers therefore take the
 * tenant's blind-index lock, then look for the value under every supported
 * version on another row; a hit is the same 409 as the unique violation. The
 * unique index stays the backstop for same-version races. The rebuild job
 * takes the same lock (worker/blind-index-rebuild.job.ts).
 */
export async function assertNoBlindIndexDuplicate(
  tx: Tx,
  tenantId: TenantId,
  ownRowId: string | null,
  normalized: Partial<Record<HrisEmployeePiiField, string>>,
): Promise<void> {
  const fields = UNIQUE_PII_FIELDS.filter(
    (field) => normalized[field] !== undefined,
  );
  if (fields.length === 0) return;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blind-index:${tenantId}`}, 0))`,
  );
  for (const field of fields) {
    const column = employees[PII_COLUMNS[field].hmac];
    const digests = hrisBlindIndexCandidates(
      field,
      tenantId,
      normalized[field]!,
    ).map((candidate) => candidate.digest);
    const [hit] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(column, digests),
          ...(ownRowId === null ? [] : [ne(employees.id, ownRowId)]),
        ),
      )
      .limit(1);
    if (hit) throw conflictError(field);
  }
}

function foreignKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23503" ||
    foreignKeyViolation(candidate.cause, depth + 1)
  );
}

export function toEmployee(row: EmployeeRow): Employee {
  return employeeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    legalEntityId: row.legalEntityId,
    employeeNo: row.employeeNo,
    fullName: row.fullName,
    positionId: row.positionId,
    orgUnitId: row.orgUnitId,
    managerId: row.managerId,
    homeOutletId: row.homeOutletId,
    employmentType: row.employmentType,
    joinDate: row.joinDate,
    endDate: row.endDate,
    ptkpStatus: row.ptkpStatus,
    status: row.status,
  });
}

async function findEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  lock = false,
): Promise<EmployeeRow | undefined> {
  const query = tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

const binding = (
  row: Pick<EmployeeRow, "tenantId" | "id">,
  field: HrisEmployeePiiField,
) => ({
  tenantId: row.tenantId,
  table: "employees" as const,
  rowId: row.id,
  field,
});

function sealedOf(
  row: EmployeeRow,
  field: HrisEmployeePiiField,
): Buffer | null {
  return (row[PII_COLUMNS[field].sealed] as Buffer | null) ?? null;
}

/** Decrypts one field in process (never returned as is). */
function openField(
  row: EmployeeRow,
  field: HrisEmployeePiiField,
): string | null {
  const sealed = sealedOf(row, field);
  if (sealed === null) return null;
  return openHrisPii(sealed, binding(row, field), row.piiKeyVersion);
}

/**
 * Masked PII for one viewer; returns the fields actually decrypted so the
 * caller can audit them. Hidden fields are never opened.
 */
function maskedPiiFor(
  row: EmployeeRow,
  viewer: NonNullable<ReturnType<HrisAccess["viewerFor"]>>,
): { pii: EmployeePii; opened: HrisEmployeePiiField[] } {
  const opened: HrisEmployeePiiField[] = [];
  const pii = {} as Record<HrisEmployeePiiField, EmployeePii["nik"]>;
  // bank_code is a plain column that travels with the bank account's visibility.
  const bankCode =
    hrisFieldVisibility(viewer, row.id, "bankAccount") === "hidden"
      ? null
      : ((row.bankCode ?? null) as EmployeePii["bankCode"]);
  for (const field of HRIS_EMPLOYEE_PII_FIELDS) {
    if (
      sealedOf(row, field) === null ||
      hrisFieldVisibility(viewer, row.id, field) === "hidden"
    ) {
      pii[field] = null;
      continue;
    }
    const plaintext = openField(row, field);
    opened.push(field);
    pii[field] =
      plaintext === null
        ? null
        : maskHrisPii(field, plaintext, row.piiKeyVersion);
  }
  return { pii: { ...pii, bankCode } as EmployeePii, opened };
}

/**
 * Sealed column values for the fields present in `input` (normalized), plus
 * the blind indexes under the active version. `blindIndexVersion` is one value
 * for the whole row, so when an existing row is still on another version every
 * other indexed value is re-indexed too (opened under the row's PII key).
 * `normalized` lists the indexed values that were written, for the
 * cross-version duplicate check.
 */
function sealedColumns(
  row: Pick<EmployeeRow, "tenantId" | "id">,
  input: UpdateEmployeePiiInput,
  existing?: EmployeeRow,
): {
  values: Partial<EmployeeRow>;
  fields: HrisEmployeePiiField[];
  normalized: Partial<Record<HrisEmployeePiiField, string>>;
} {
  const values: Record<string, unknown> = {};
  const fields: HrisEmployeePiiField[] = [];
  const normalized: Partial<Record<HrisEmployeePiiField, string>> = {};
  for (const field of HRIS_EMPLOYEE_PII_FIELDS) {
    const raw = input[field];
    if (raw === undefined) continue;
    const value = normalizeHrisPii(field, raw);
    const columns = PII_COLUMNS[field];
    values[columns.sealed] = sealHrisPii(
      value,
      binding(row, field),
      HRIS_PII_KEY_VERSION,
    );
    if (columns.hmac !== null && hrisPiiHasBlindIndex(field)) {
      values[columns.hmac] = hrisBlindIndex(field, row.tenantId, value);
      normalized[field] = value;
    }
    fields.push(field);
  }
  if (Object.keys(normalized).length > 0) {
    if (existing && existing.blindIndexVersion !== BLIND_INDEX_ACTIVE_VERSION) {
      for (const field of HRIS_EMPLOYEE_PII_FIELDS) {
        const columns = PII_COLUMNS[field];
        if (
          normalized[field] !== undefined ||
          input[field] !== undefined ||
          columns.hmac === null ||
          !hrisPiiHasBlindIndex(field)
        )
          continue;
        const plaintext = openField(existing, field);
        if (plaintext === null) continue;
        const value = normalizeHrisPii(field, plaintext);
        values[columns.hmac] = hrisBlindIndex(field, row.tenantId, value);
        normalized[field] = value;
      }
    }
    values.blindIndexVersion = BLIND_INDEX_ACTIVE_VERSION;
  }
  return { values: values as Partial<EmployeeRow>, fields, normalized };
}

/** Rows whose home outlet the caller reaches for any HR read code. */
function readableCondition(access: HrisAccess): SQL | null {
  const reach = access.reach([
    "hr.employee.view",
    "hr.employee.manage",
    "payroll.view",
  ]);
  if (reach === null) return null;
  if (reach.kind === "tenant") return sql`true`;
  return inArray(employees.homeOutletId, [...reach.outletIds]);
}

// ------------------------------------------------------------------ reads

/** GET /api/hris/employees — HR master data list (no PII). */
export async function listEmployees(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListEmployeesQuery,
): Promise<Page<Employee>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const readable = readableCondition(access);
    if (readable === null) throw forbidden();
    const filters: SQL[] = [
      eq(employees.tenantId, context.tenant.tenantId),
      readable,
    ];
    if (query.status) filters.push(eq(employees.status, query.status));
    if (query.outletId)
      filters.push(eq(employees.homeOutletId, query.outletId));
    if (query.positionId)
      filters.push(eq(employees.positionId, query.positionId));
    if (query.cursor) {
      const [employeeNo, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(employees.employeeNo, employeeNo),
          and(eq(employees.employeeNo, employeeNo), gt(employees.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(employees)
      .where(and(...filters))
      .orderBy(asc(employees.employeeNo), asc(employees.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toEmployee),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.employeeNo, last.id])
            : null,
      },
    };
  });
}

/** GET /api/hris/employees/:employeeId — HR-01: own row or HR reach, else 404. */
export async function getEmployee(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
): Promise<EmployeeProfile> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const row = await findEmployee(tx, context, employeeId);
    if (!row || access.viewerFor(row) === null) throw notFound();
    return {
      ...toEmployee(row),
      canChangeManager: mayChangeEmployeeManager(access, row),
    };
  });
}

/** GET /api/hris/me — the caller's own row (HR-01: no id in the request). */
export async function getMyHrisProfile(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<MyHrisProfile> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    if (access.own === null) throw notFound();
    const row = await findEmployee(tx, context, access.own.id);
    if (!row) throw notFound();
    const [outlet] = await tx
      .select()
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, row.homeOutletId),
        ),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    return {
      employee: toEmployee(row),
      outlet: outletRefSchema.parse({
        id: outlet.id,
        tenantId: outlet.tenantId,
        brandId: outlet.brandId,
        code: outlet.code,
        name: outlet.name,
        timeZone: outlet.timezone,
        status: outlet.status,
      }),
    };
  });
}

/** GET /api/hris/employees/:employeeId/pii — HR-03 masked PII, audited. */
export async function getEmployeePii(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  now = new Date(),
): Promise<EmployeePii> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findEmployee(tx, context, employeeId);
    const viewer = row ? access.viewerFor(row) : null;
    if (!row || viewer === null) throw notFound();
    const { pii, opened } = maskedPiiFor(row, viewer);
    if (opened.length > 0)
      await recordAudit(
        tx,
        context,
        hrisAuditEntry(context, access.actorUserId, now, {
          outletId: row.homeOutletId,
          action: "hris.employee_pii.viewed",
          objectType: "employee",
          objectId: row.id,
          after: { fields: opened, viewerKind: viewer.kind },
          sensitiveReason: "Melihat data pribadi karyawan (tersamar).",
        }),
        HRIS_AUDIT_SAFE_FIELDS,
      );
    return pii;
  });
}

// ----------------------------------------------------------------- writes

/**
 * Operations whose request carries a PIN or code that the caller GUESSES.
 * Those fields stay out of the stored fingerprint: a replay compared on them
 * would answer "stored outcome" for the right guess and 409 for any other, an
 * oracle that costs no attempt (also while locked). A replay only returns the
 * stored outcome; every fresh key runs `run`, which counts the attempt under
 * the PIN row lock.
 */
const GUESS_FIELDS_BY_OPERATION: Readonly<Record<string, readonly string[]>> = {
  "payslip_pin.set": ["pin", "currentPin"],
  "payslip_pin.wa_reset": ["pin"],
};

function withoutGuessFields(operation: string, request: unknown): unknown {
  const fields = GUESS_FIELDS_BY_OPERATION[operation];
  if (!fields || typeof request !== "object" || request === null)
    return request;
  const rest: Record<string, unknown> = { ...request };
  for (const field of fields) delete rest[field];
  return rest;
}

/** Idempotent HRIS write bound to an HMAC fingerprint of the request. */
export async function idempotentHrisWrite<T>(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const parsedKey = idempotencyKeySchema.parse(key);
  const fingerprintInput = {
    operation,
    request: withoutGuessFields(operation, request),
  };
  const fingerprint = hrisRequestFingerprint(
    context.tenant.tenantId,
    fingerprintInput,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:idem:${context.tenant.tenantId}:${parsedKey}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(hrisIdempotency)
    .where(
      and(
        eq(hrisIdempotency.tenantId, context.tenant.tenantId),
        eq(hrisIdempotency.key, parsedKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== operation ||
      !hrisFingerprintMatches(
        context.tenant.tenantId,
        fingerprintInput,
        existing.fingerprint,
      )
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(hrisIdempotency).values({
    tenantId: context.tenant.tenantId,
    key: parsedKey,
    operation,
    fingerprint,
    response: response as object,
  });
  return response;
}

/**
 * PUT /api/hris/employees/:employeeId/pii — HR writes write-only PII; the
 * service normalizes, seals (AES-256-GCM, row-bound AAD) and blind-indexes
 * each value. Needs `hr.employee.manage` on the home outlet: self-service
 * edits of payroll/identity data are not allowed (fraud-sensitive; PRD only
 * names HR for this data).
 */
export async function updateEmployeePii(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  body: UpdatePiiBody,
  now = new Date(),
): Promise<EmployeePii> {
  const { idempotencyKey, ...input } = body;
  const values = updateEmployeePiiInputSchema.parse(input);
  if (Object.keys(values).length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Tidak ada perubahan.");
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findEmployee(tx, context, employeeId, true);
    const viewer = row ? access.viewerFor(row) : null;
    if (!row || viewer === null) throw notFound();
    if (!access.permissionsAt(row.homeOutletId).includes(HRIS_MANAGE_CODE))
      throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "employee_pii.update",
      { actor: access.actorUserId, employeeId: row.id, values },
      async () => {
        if (row.piiKeyVersion !== HRIS_PII_KEY_VERSION)
          // Re-sealing old-version columns is the rotation job's work.
          throw new CoreError(
            "CONFLICT",
            "Data pribadi karyawan ini menunggu rotasi kunci.",
          );
        const sealed = sealedColumns(row, values, row);
        await assertNoBlindIndexDuplicate(
          tx,
          context.tenant.tenantId,
          row.id,
          sealed.normalized,
        );
        let updated: EmployeeRow | undefined;
        try {
          [updated] = await tx
            .update(employees)
            .set({
              ...sealed.values,
              // A new account without an explicit code clears the old code: a
              // stale code on a different bank's account must never reach the
              // transfer file (payout then stays bank_code_missing).
              ...(values.bankCode !== undefined
                ? { bankCode: values.bankCode }
                : values.bankAccount !== undefined
                  ? { bankCode: null }
                  : {}),
              piiKeyVersion: HRIS_PII_KEY_VERSION,
              updatedAt: now,
            })
            .where(
              and(
                eq(employees.tenantId, context.tenant.tenantId),
                eq(employees.id, row.id),
              ),
            )
            .returning();
        } catch (error) {
          throw duplicateError(error) ?? error;
        }
        if (!updated) throw notFound();
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, access.actorUserId, now, {
            outletId: row.homeOutletId,
            action: "hris.employee_pii.updated",
            objectType: "employee",
            objectId: row.id,
            after: {
              changedFields:
                values.bankCode !== undefined ||
                values.bankAccount !== undefined
                  ? [...sealed.fields, "bankCode"]
                  : sealed.fields,
            },
          }),
          HRIS_AUDIT_SAFE_FIELDS,
        );
        const result = maskedPiiFor(updated, viewer);
        // The response masks what was just written, which is a decrypt too.
        if (result.opened.length > 0)
          await recordAudit(
            tx,
            context,
            hrisAuditEntry(context, access.actorUserId, now, {
              outletId: row.homeOutletId,
              action: "hris.employee_pii.viewed",
              objectType: "employee",
              objectId: row.id,
              after: { fields: result.opened, viewerKind: viewer.kind },
              sensitiveReason: "Menampilkan data pribadi setelah diubah.",
            }),
            HRIS_AUDIT_SAFE_FIELDS,
          );
        return result.pii;
      },
    );
  });
}

/**
 * Server-side plaintext of selected PII fields (payroll bank transfer file,
 * Coretax export, HR edit pre-fill rendered on the server). Never wire this to
 * an HTTP response: the contract keeps plaintext off the wire (pii.ts).
 *
 * Fail closed: the caller must be an `hr` viewer (hr.employee.manage) or a
 * `payroll` viewer that also holds `payroll.run`, on the employee's home
 * outlet, with visibility `full` for every requested field; `purpose` is
 * required and lands in the sensitive-access audit row.
 */
export async function revealEmployeePii(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  fields: readonly HrisEmployeePiiField[],
  purpose: string,
  now = new Date(),
): Promise<Partial<Record<HrisEmployeePiiField, string | null>>> {
  const reason = purpose.trim();
  if (reason.length === 0 || reason.length > 300)
    throw new HttpError(422, "VALIDATION_ERROR", "Tujuan akses wajib diisi.");
  if (fields.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Pilih data yang dibuka.");
  for (const field of fields)
    if (!(HRIS_EMPLOYEE_PII_FIELDS as readonly string[]).includes(field))
      throw new HttpError(422, "VALIDATION_ERROR", "Field tidak dikenal.");
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findEmployee(tx, context, employeeId);
    const viewer = row ? access.viewerFor(row) : null;
    if (!row || viewer === null) throw notFound();
    const codes = access.permissionsAt(row.homeOutletId);
    const decryptAllowed =
      (viewer.kind === "hr" && codes.includes("hr.employee.manage")) ||
      (viewer.kind === "payroll" && codes.includes("payroll.run"));
    if (!decryptAllowed) throw forbidden();
    for (const field of fields)
      if (hrisFieldVisibility(viewer, row.id, field) !== "full")
        throw forbidden();
    const result: Partial<Record<HrisEmployeePiiField, string | null>> = {};
    for (const field of fields) result[field] = openField(row, field);
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: row.homeOutletId,
        action: "hris.employee_pii.revealed",
        objectType: "employee",
        objectId: row.id,
        after: { fields: [...fields], viewerKind: viewer.kind },
        sensitiveReason: reason,
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return result;
  });
}

/** New employee (import tooling, onboarding). No HTTP route in the contract yet. */
export type CreateEmployeeInput = Omit<
  Employee,
  "id" | "tenantId" | "status"
> & {
  readonly status: Extract<EmployeeStatus, "onboarding" | "active">;
  readonly pii?: UpdateEmployeePiiInput;
  readonly idempotencyKey?: string;
};

async function seatQuota(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<{ limit: number; used: number }> {
  const [tenant] = await tx
    .select({ limits: tenants.limits })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  const limits = tenantLimitsSchema.safeParse(tenant?.limits);
  // No readable plan quota → no new employee (fail closed).
  if (!limits.success)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Kuota karyawan paket tenant belum dikonfigurasi.",
    );
  const [count] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        inArray(employees.status, [...HRIS_SEAT_STATUSES]),
      ),
    );
  return {
    limit: limits.data.maxActiveEmployees,
    used: count?.value ?? 0,
  };
}

/**
 * HR-04: creates an employee only while seats remain under the tenant plan
 * quota. Concurrent creates in one tenant queue on a transaction-scoped
 * advisory lock, so the count and the insert are one atomic decision.
 */
export async function createEmployee(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateEmployeeInput,
  now = new Date(),
): Promise<Employee> {
  const { pii, idempotencyKey, ...master } = input;
  const id = randomUUID();
  const candidate = employeeSchema.parse({
    ...master,
    id,
    tenantId: context.tenant.tenantId,
  });
  if (candidate.status !== "onboarding" && candidate.status !== "active")
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Karyawan baru berstatus onboarding atau active.",
    );
  const piiInput = updateEmployeePiiInputSchema.parse(pii ?? {});
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (
      !access.permissionsAt(candidate.homeOutletId).includes(HRIS_MANAGE_CODE)
    )
      throw forbidden();
    if (!isOutletInScope(context.outletScope, candidate.homeOutletId))
      throw forbidden();
    for (const [table, referenceId] of [
      [outlets, candidate.homeOutletId],
      [legalEntities, candidate.legalEntityId],
      [orgUnits, candidate.orgUnitId],
      [positions, candidate.positionId],
    ] as const) {
      if (referenceId === null) continue;
      const [reference] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.tenantId, context.tenant.tenantId),
            eq(table.id, referenceId),
          ),
        )
        .limit(1);
      if (!reference) throw notFound();
    }
    if (candidate.managerId !== null) {
      const manager = await findEmployee(tx, context, candidate.managerId);
      if (
        !manager ||
        !isOutletInScope(context.outletScope, manager.homeOutletId) ||
        !access.permissionsAt(manager.homeOutletId).includes(HRIS_MANAGE_CODE)
      )
        throw notFound();
    }
    if (candidate.userId !== null) {
      const [assignment] = await tx
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.tenantId, context.tenant.tenantId),
            eq(roleAssignments.userId, candidate.userId),
            // DB clock, the one that stamps valid_from/valid_until (bead 1201).
            lte(roleAssignments.validFrom, sql`statement_timestamp()`),
            or(
              isNull(roleAssignments.validUntil),
              gt(roleAssignments.validUntil, sql`statement_timestamp()`),
            ),
          ),
        )
        .limit(1);
      if (!assignment) throw notFound();
    }
    const create = async () => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:employee-quota:${context.tenant.tenantId}`}, 0))`,
      );
      const quota = await seatQuota(tx, context);
      if (quota.used + 1 > quota.limit)
        throw new PlatformError("QUOTA_EXCEEDED");
      const sealed = sealedColumns(
        { tenantId: context.tenant.tenantId, id },
        piiInput,
      );
      await assertNoBlindIndexDuplicate(
        tx,
        context.tenant.tenantId,
        null,
        sealed.normalized,
      );
      let row: EmployeeRow | undefined;
      try {
        [row] = await tx
          .insert(employees)
          .values({
            id,
            tenantId: context.tenant.tenantId,
            userId: candidate.userId,
            legalEntityId: candidate.legalEntityId,
            employeeNo: candidate.employeeNo,
            fullName: candidate.fullName,
            positionId: candidate.positionId,
            orgUnitId: candidate.orgUnitId,
            managerId: candidate.managerId,
            homeOutletId: candidate.homeOutletId,
            employmentType: candidate.employmentType,
            joinDate: candidate.joinDate,
            endDate: candidate.endDate,
            ptkpStatus: candidate.ptkpStatus,
            status: candidate.status,
            ...sealed.values,
            bankCode: piiInput.bankCode ?? null,
            blindIndexVersion: BLIND_INDEX_ACTIVE_VERSION,
            piiKeyVersion: HRIS_PII_KEY_VERSION,
            createdBy: access.actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      } catch (error) {
        const duplicate = duplicateError(error);
        if (duplicate) throw duplicate;
        if (foreignKeyViolation(error))
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Jabatan, unit, atasan, outlet atau badan usaha tidak ditemukan.",
          );
        throw error;
      }
      if (!row) throw new Error("Employee insert returned no row");
      await recordAudit(
        tx,
        context,
        hrisAuditEntry(context, access.actorUserId, now, {
          outletId: row.homeOutletId,
          action: "hris.employee.created",
          objectType: "employee",
          objectId: row.id,
          after: {
            employeeNo: row.employeeNo,
            status: row.status,
            employmentType: row.employmentType,
            changedFields:
              piiInput.bankCode != null
                ? [...sealed.fields, "bankCode"]
                : sealed.fields,
          },
        }),
        HRIS_AUDIT_SAFE_FIELDS,
      );
      return toEmployee(row);
    };
    return idempotencyKey === undefined
      ? create()
      : idempotentHrisWrite(
          tx,
          context,
          idempotencyKey,
          "employee.create",
          { actor: access.actorUserId, master, pii: piiInput },
          create,
        );
  });
}
