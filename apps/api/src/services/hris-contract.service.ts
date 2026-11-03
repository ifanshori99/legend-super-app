// Employment contracts and employee documents (PRD v1.7 §3 F26 "Kontrak
// Kerja", "Profil Karyawan ... dokumen (KTP, kontrak, sertifikat)"; §6 H
// `employment_contracts`, `employee_documents`; HR-01, HR-03; bead
// legend-qe1z). Routes: routes/hris.routes.ts.
//
// - A row is visible to HR readers whose reach covers the employee's home
//   outlet, or to the employee themself (HR-01). Anyone else gets 404 / an
//   empty page, never a hint that the row exists.
// - `salarySnapshot` is sealed (HR-03) and served masked only to viewers whose
//   visibility allows it (HR / payroll; not supervisors, not self — the
//   contract field is not self-service). Every decrypt is audited.
// - Files live in the private bucket. URLs are minted by an injected signer
//   port (`HrisFileSigner`, core-storage); the default signer mints nothing,
//   so `fileUrl` / `downloadUrl` stay null until storage is wired (fail
//   closed). Each minted URL is audited.

import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { encodeCursor, type ScopedTenantContext } from "@starter/shared/core";
import {
  HRIS_PII_FIELDS,
  canReadEmployeeDocument,
  employeeDocumentSchema,
  employmentContractSchema,
  listEmployeeDocuments as listEmployeeDocumentsEndpoint,
  listEmploymentContracts as listEmploymentContractsEndpoint,
  type EmployeeDocument,
  type EmployeeDocumentType,
  type EmploymentContract,
  type EmploymentContractStatus,
  type EmploymentType,
  type HrisViewer,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  employeeDocuments,
  employees,
  employmentContracts,
} from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  HRIS_PII_KEY_VERSION,
  maskHrisPii,
  normalizeHrisPii,
  openHrisPii,
  sealHrisPii,
} from "../lib/hris-pii.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  HRIS_READ_CODES,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  hrisDefinitionVisibility,
  hrisFieldVisibility,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";

type ContractRow = typeof employmentContracts.$inferSelect;
type DocumentRow = typeof employeeDocuments.$inferSelect;
type ContractsQuery = z.output<typeof listEmploymentContractsEndpoint.query>;
type DocumentsQuery = z.output<typeof listEmployeeDocumentsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/**
 * Port to core-storage `signedStorageUrl` for a private object. Returns null
 * when no URL may or can be minted. Injected by the route bootstrap.
 */
export type HrisFileSigner = (
  context: ScopedTenantContext,
  storageObjectId: string,
) => Promise<string | null>;
export const noHrisFileSigner: HrisFileSigner = async () => null;

const contractBinding = (row: Pick<ContractRow, "tenantId" | "id">) => ({
  tenantId: row.tenantId,
  table: "employment_contracts" as const,
  rowId: row.id,
  field: "salarySnapshot" as const,
});

/** Contracts/documents the caller may see: HR reach or their own rows. */
function ownerCondition(access: HrisAccess): SQL | null {
  const reach = access.reach(HRIS_READ_CODES);
  const conditions: SQL[] = [];
  if (reach?.kind === "tenant") conditions.push(sql`true`);
  else if (reach)
    conditions.push(inArray(employees.homeOutletId, [...reach.outletIds]));
  if (
    access.own !== null &&
    access.snapshot.permissions.includes("self.profile.view")
  )
    conditions.push(eq(employees.id, access.own.id));
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
}

async function toContract(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  viewer: HrisViewer,
  row: ContractRow,
  homeOutletId: string,
  signer: HrisFileSigner,
  now: Date,
): Promise<EmploymentContract> {
  let salarySnapshot: EmploymentContract["salarySnapshot"] = null;
  const opened: string[] = [];
  if (
    row.salarySnapshotEncrypted !== null &&
    hrisFieldVisibility(viewer, row.employeeId, "salarySnapshot") !== "hidden"
  ) {
    const plaintext = openHrisPii(
      row.salarySnapshotEncrypted,
      contractBinding(row),
      row.piiKeyVersion,
    );
    salarySnapshot = maskHrisPii(
      "salarySnapshot",
      plaintext,
      row.piiKeyVersion,
    );
    opened.push("salarySnapshot");
  }
  let fileUrl: string | null = null;
  if (
    row.fileObjectId !== null &&
    hrisDefinitionVisibility(
      viewer,
      row.employeeId,
      HRIS_PII_FIELDS.contractFileUrl,
    ) !== "hidden"
  ) {
    fileUrl = await signer(context, row.fileObjectId);
    if (fileUrl !== null) opened.push("fileUrl");
  }
  if (opened.length > 0)
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: homeOutletId,
        action: "hris.employment_contract.viewed",
        objectType: "employment_contract",
        objectId: row.id,
        after: { fields: opened, viewerKind: viewer.kind },
        sensitiveReason: "Melihat data kontrak kerja (tersamar).",
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
  return employmentContractSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    type: row.type,
    startDate: row.startDate,
    endDate: row.endDate,
    renewedFromId: row.renewedFromId,
    salarySnapshot,
    fileUrl,
    reminderDaysBefore: row.reminderDaysBefore,
    status: row.status,
  });
}

/** GET /api/hris/employment-contracts */
export async function listEmploymentContracts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ContractsQuery,
  signer: HrisFileSigner = noHrisFileSigner,
  now = new Date(),
): Promise<Page<EmploymentContract>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const visible = ownerCondition(access);
    if (visible === null) throw forbidden();
    const filters: SQL[] = [
      eq(employmentContracts.tenantId, context.tenant.tenantId),
      visible,
    ];
    if (query.employeeId)
      filters.push(eq(employmentContracts.employeeId, query.employeeId));
    if (query.status)
      filters.push(eq(employmentContracts.status, query.status));
    if (query.expiringBefore)
      filters.push(lte(employmentContracts.endDate, query.expiringBefore));
    if (query.cursor) {
      const [startDate, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(employmentContracts.startDate, startDate),
          and(
            eq(employmentContracts.startDate, startDate),
            lt(employmentContracts.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({
        contract: employmentContracts,
        homeOutletId: employees.homeOutletId,
      })
      .from(employmentContracts)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, employmentContracts.tenantId),
          eq(employees.id, employmentContracts.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(
        desc(employmentContracts.startDate),
        desc(employmentContracts.id),
      )
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const data: EmploymentContract[] = [];
    for (const { contract, homeOutletId } of pageRows) {
      const viewer = access.viewerFor({
        id: contract.employeeId,
        homeOutletId,
      });
      if (viewer === null) continue; // defensive; the SQL filter matches viewerFor
      data.push(
        await toContract(
          tx,
          context,
          access,
          viewer,
          contract,
          homeOutletId,
          signer,
          now,
        ),
      );
    }
    const last = pageRows.at(-1)?.contract;
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.startDate, last.id])
            : null,
      },
    };
  });
}

/** GET /api/hris/employment-contracts/:contractId */
export async function getEmploymentContract(
  context: ScopedTenantContext,
  actorUserId: string,
  contractId: string,
  signer: HrisFileSigner = noHrisFileSigner,
  now = new Date(),
): Promise<EmploymentContract> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [found] = await tx
      .select({
        contract: employmentContracts,
        homeOutletId: employees.homeOutletId,
      })
      .from(employmentContracts)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, employmentContracts.tenantId),
          eq(employees.id, employmentContracts.employeeId),
        ),
      )
      .where(
        and(
          eq(employmentContracts.tenantId, context.tenant.tenantId),
          eq(employmentContracts.id, contractId),
        ),
      )
      .limit(1);
    const viewer = found
      ? access.viewerFor({
          id: found.contract.employeeId,
          homeOutletId: found.homeOutletId,
        })
      : null;
    if (!found || viewer === null) throw notFound("Kontrak kerja");
    return toContract(
      tx,
      context,
      access,
      viewer,
      found.contract,
      found.homeOutletId,
      signer,
      now,
    );
  });
}

/** GET /api/hris/employees/:employeeId/documents — HR or the employee (HR-01). */
export async function listEmployeeDocuments(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  query: DocumentsQuery,
  signer: HrisFileSigner = noHrisFileSigner,
  now = new Date(),
): Promise<Page<EmployeeDocument>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [employee] = await tx
      .select({ id: employees.id, homeOutletId: employees.homeOutletId })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, employeeId),
        ),
      )
      .limit(1);
    const viewer = employee ? access.viewerFor(employee) : null;
    if (!employee || viewer === null) throw notFound();
    // Document class: HR and the owner only (supervisor / payroll hidden).
    if (
      !canReadEmployeeDocument(
        viewer.employeeId,
        employee.id as EmployeeDocument["employeeId"],
        viewer.kind === "hr",
      )
    )
      throw forbidden();
    const filters: SQL[] = [
      eq(employeeDocuments.tenantId, context.tenant.tenantId),
      eq(employeeDocuments.employeeId, employee.id),
    ];
    if (query.cursor) {
      const [uploadedAt, id] = cursorPair(query.cursor);
      const at = new Date(uploadedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lt(employeeDocuments.uploadedAt, at),
          and(
            eq(employeeDocuments.uploadedAt, at),
            lt(employeeDocuments.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(employeeDocuments)
      .where(and(...filters))
      .orderBy(desc(employeeDocuments.uploadedAt), desc(employeeDocuments.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const urlAllowed =
      hrisDefinitionVisibility(
        viewer,
        employee.id,
        HRIS_PII_FIELDS.employeeDocumentFileUrl,
      ) !== "hidden";
    const data: EmployeeDocument[] = [];
    for (const row of pageRows) {
      const downloadUrl = urlAllowed
        ? await signer(context, row.storageObjectId)
        : null;
      if (downloadUrl !== null)
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, access.actorUserId, now, {
            outletId: employee.homeOutletId,
            action: "hris.employee_document.url_issued",
            objectType: "employee_document",
            objectId: row.id,
            after: { type: row.type, viewerKind: viewer.kind },
            sensitiveReason: "Membuka dokumen karyawan.",
          }),
          HRIS_AUDIT_SAFE_FIELDS,
        );
      data.push(toDocument(row, downloadUrl));
    }
    const last = pageRows.at(-1);
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.uploadedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

function toDocument(
  row: DocumentRow,
  downloadUrl: string | null,
): EmployeeDocument {
  return employeeDocumentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    type: row.type,
    downloadUrl,
    expiresOn: row.expiresOn,
    uploadedAt: row.uploadedAt.toISOString(),
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  });
}

// ------------------------------------------------- service-level creates

async function managedEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  employeeId: string,
) {
  const [employee] = await tx
    .select({ id: employees.id, homeOutletId: employees.homeOutletId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  if (!employee || access.viewerFor(employee) === null) throw notFound();
  if (!access.permissionsAt(employee.homeOutletId).includes(HRIS_MANAGE_CODE))
    throw forbidden();
  return employee;
}

export type CreateEmploymentContractInput = {
  readonly employeeId: string;
  readonly type: EmploymentType;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly renewedFromId: string | null;
  /** Whole rupiah; sealed before storing (HR-03). */
  readonly salarySnapshotIdr: number | null;
  readonly fileObjectId: string | null;
  readonly reminderDaysBefore: number;
  readonly status?: EmploymentContractStatus;
};

/** Records a contract (HR, `hr.employee.manage` on the home outlet). No route yet. */
export async function createEmploymentContract(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateEmploymentContractInput,
  now = new Date(),
): Promise<EmploymentContract> {
  const id = randomUUID();
  // Contract refinements (PKWT ends, PKWTT does not, ...) before any write.
  employmentContractSchema.parse({
    id,
    tenantId: context.tenant.tenantId,
    employeeId: input.employeeId,
    type: input.type,
    startDate: input.startDate,
    endDate: input.endDate,
    renewedFromId: input.renewedFromId,
    salarySnapshot: null,
    fileUrl: null,
    reminderDaysBefore: input.reminderDaysBefore,
    status: input.status ?? "draft",
  });
  const salary =
    input.salarySnapshotIdr === null
      ? null
      : normalizeHrisPii("salarySnapshot", String(input.salarySnapshotIdr));
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const employee = await managedEmployee(
      tx,
      context,
      access,
      input.employeeId,
    );
    const [row] = await tx
      .insert(employmentContracts)
      .values({
        id,
        tenantId: context.tenant.tenantId,
        employeeId: employee.id,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        renewedFromId: input.renewedFromId,
        salarySnapshotEncrypted:
          salary === null
            ? null
            : sealHrisPii(
                salary,
                contractBinding({ tenantId: context.tenant.tenantId, id }),
                HRIS_PII_KEY_VERSION,
              ),
        piiKeyVersion: HRIS_PII_KEY_VERSION,
        fileObjectId: input.fileObjectId,
        reminderDaysBefore: input.reminderDaysBefore,
        status: input.status ?? "draft",
        createdBy: access.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Contract insert returned no row");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: employee.homeOutletId,
        action: "hris.employment_contract.created",
        objectType: "employment_contract",
        objectId: row.id,
        after: {
          type: row.type,
          status: row.status,
          changedFields: salary === null ? [] : ["salarySnapshot"],
        },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    const viewer = access.viewerFor(employee)!;
    return toContract(
      tx,
      context,
      access,
      viewer,
      row,
      employee.homeOutletId,
      noHrisFileSigner,
      now,
    );
  });
}

export type CreateEmployeeDocumentInput = {
  readonly employeeId: string;
  readonly type: EmployeeDocumentType;
  /** Already uploaded through core-storage (purpose `document`, private). */
  readonly storageObjectId: string;
  readonly expiresOn: string | null;
};

/** Records document metadata (HR). The bytes went through core-storage. */
export async function createEmployeeDocument(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateEmployeeDocumentInput,
  now = new Date(),
): Promise<EmployeeDocument> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const employee = await managedEmployee(
      tx,
      context,
      access,
      input.employeeId,
    );
    const [row] = await tx
      .insert(employeeDocuments)
      .values({
        tenantId: context.tenant.tenantId,
        employeeId: employee.id,
        type: input.type,
        storageObjectId: input.storageObjectId,
        expiresOn: input.expiresOn,
        uploadedAt: now,
        uploadedBy: access.actorUserId,
      })
      .returning();
    if (!row) throw new Error("Document insert returned no row");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: employee.homeOutletId,
        action: "hris.employee_document.created",
        objectType: "employee_document",
        objectId: row.id,
        after: { type: row.type },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return toDocument(row, null);
  });
}
