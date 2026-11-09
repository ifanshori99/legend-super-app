// Statutory table versions: BPJS, PTKP, TER, PPh 21 annual, overtime, THR
// (bead legend-gfcr, PRD v1.7 PAYR-02 / R20; contract `@starter/shared/hris/
// payroll` statutory.ts + endpoints.ts). Routes: routes/payroll-statutory.routes.ts.
//
// A version is a draft until it is published. A draft can be edited, then
// published or archived exactly once; a published or archived row never
// changes (the service answers PAYROLL_STATUTORY_TABLE_IMMUTABLE, and the
// `statutory_rates_guard_trg` trigger refuses a direct write with 23514).
// The version number is max + 1 per (tenant, type) inside the transaction; a
// concurrent writer that loses the unique index race gets a 409. Publishing
// uses the server business date (never the client clock): a backdated version
// is PAYROLL_STATUTORY_TABLE_BACKDATED, and a second published version for the
// same (type, effectiveFrom) is a 409. Reading needs `payroll.view`, writing
// `payroll.run`, both tenant-wide. Parameters are parsed with the contract
// schema on write and again on read, so a row edited outside the service
// fails loudly instead of silently changing a rate.

import { and, desc, eq, lt, or, max, type SQL } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PayrollError,
  archiveStatutoryVersion,
  assertStatutoryVersionEditable,
  publishStatutoryVersion,
  statutoryTableVersionSchema,
  type StatutoryTableDraftInput,
  type StatutoryTableType,
  type StatutoryTableVersion,
  type StatutoryTableVersionId,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { statutoryRates } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { cursorPair, notFound, uniqueViolation } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

const READ_CODE: PermissionCode = "payroll.view";
const WRITE_CODE: PermissionCode = "payroll.run";

/** Field names only: type, status, version and date are enums or numbers. */
const AUDIT_SAFE_FIELDS = [
  "type",
  "version",
  "status",
  "effectiveFrom",
] as const;

type Row = typeof statutoryRates.$inferSelect;

export type StatutoryTablePage = {
  readonly data: StatutoryTableVersion[];
  readonly meta: { readonly limit: number; readonly nextCursor: string | null };
};

export type StatutoryTableWrite = {
  readonly draft: StatutoryTableDraftInput;
  readonly effectiveFrom: StatutoryTableVersion["effectiveFrom"];
  readonly legalBasis: string;
};

const toVersion = (row: Row): StatutoryTableVersion =>
  statutoryTableVersionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    legalBasis: row.legalBasis,
    // The contract schema of the row's type re-validates what the DB holds.
    parameters: row.parameters,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });

const raceConflict = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Versi tabel statutori baru saja dibuat. Muat ulang lalu coba lagi.",
  );

const sameDateConflict = () =>
  new PayrollError(
    "PAYROLL_STATUTORY_TABLE_AMBIGUOUS",
    "Sudah ada versi terbit untuk jenis tabel dan tanggal berlaku yang sama.",
  );

async function loadRowForUpdate(
  tx: Tx,
  context: ScopedTenantContext,
  versionId: StatutoryTableVersionId,
): Promise<Row> {
  const [row] = await tx
    .select()
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.tenantId, context.tenant.tenantId),
        eq(statutoryRates.id, versionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw notFound("Tabel statutori");
  return row;
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  now: Date,
  action: string,
  before: StatutoryTableVersion | null,
  after: StatutoryTableVersion,
): Promise<void> {
  const fields = (version: StatutoryTableVersion) => ({
    type: version.type,
    version: version.version,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "statutory_rate",
      objectId: after.id,
      reason: null,
      maskedChanges: {
        before: before ? fields(before) : null,
        after: fields(after),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------------- reads

/** Newest effective date first; cursor is `[effectiveFrom, id]`. */
export async function listStatutoryTables(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    readonly type?: StatutoryTableType | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  },
): Promise<StatutoryTablePage> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const filters: SQL[] = [
      eq(statutoryRates.tenantId, context.tenant.tenantId),
    ];
    if (query.type !== undefined)
      filters.push(eq(statutoryRates.type, query.type));
    if (query.cursor) {
      const [date, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(statutoryRates.effectiveFrom, date),
          and(
            eq(statutoryRates.effectiveFrom, date),
            lt(statutoryRates.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(statutoryRates)
      .where(and(...filters))
      .orderBy(desc(statutoryRates.effectiveFrom), desc(statutoryRates.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toVersion),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.effectiveFrom, last.id])
            : null,
      },
    };
  });
}

export async function getStatutoryTable(
  context: ScopedTenantContext,
  actorUserId: string,
  versionId: StatutoryTableVersionId,
): Promise<StatutoryTableVersion> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const [row] = await tx
      .select()
      .from(statutoryRates)
      .where(
        and(
          eq(statutoryRates.tenantId, context.tenant.tenantId),
          eq(statutoryRates.id, versionId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Tabel statutori");
    return toVersion(row);
  });
}

// ------------------------------------------------------------------ writes

export async function createStatutoryTableDraft(
  context: ScopedTenantContext,
  actorUserId: string,
  input: StatutoryTableWrite,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<StatutoryTableVersion> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.statutory_table.create",
      { actor, ...input },
      async () => {
        const [latest] = await tx
          .select({ version: max(statutoryRates.version) })
          .from(statutoryRates)
          .where(
            and(
              eq(statutoryRates.tenantId, context.tenant.tenantId),
              eq(statutoryRates.type, input.draft.type),
            ),
          );
        let row: Row | undefined;
        try {
          [row] = await tx
            .insert(statutoryRates)
            .values({
              tenantId: context.tenant.tenantId,
              type: input.draft.type,
              version: (latest?.version ?? 0) + 1,
              effectiveFrom: input.effectiveFrom,
              status: "draft",
              legalBasis: input.legalBasis,
              parameters: input.draft.parameters,
              createdBy: actor,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (error) {
          if (uniqueViolation(error)) throw raceConflict();
          throw error;
        }
        if (!row) throw new Error("Statutory table version was not stored");
        const created = toVersion(row);
        await audit(
          tx,
          context,
          actor,
          now,
          "payroll.statutory_table.created",
          null,
          created,
        );
        return created;
      },
    );
  });
}

export async function updateStatutoryTableDraft(
  context: ScopedTenantContext,
  actorUserId: string,
  versionId: StatutoryTableVersionId,
  input: StatutoryTableWrite,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<StatutoryTableVersion> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.statutory_table.update",
      { actor, versionId, ...input },
      async () => {
        const row = await loadRowForUpdate(tx, context, versionId);
        const before = toVersion(row);
        assertStatutoryVersionEditable(before.status);
        // The type is part of the row identity (trigger refuses a change).
        if (input.draft.type !== before.type)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Jenis tabel statutori tidak dapat diubah.",
          );
        const [updated] = await tx
          .update(statutoryRates)
          .set({
            effectiveFrom: input.effectiveFrom,
            legalBasis: input.legalBasis,
            parameters: input.draft.parameters,
            updatedAt: now,
          })
          .where(
            and(
              eq(statutoryRates.tenantId, context.tenant.tenantId),
              eq(statutoryRates.id, versionId),
            ),
          )
          .returning();
        if (!updated) throw new Error("Statutory table version was not stored");
        const after = toVersion(updated);
        await audit(
          tx,
          context,
          actor,
          now,
          "payroll.statutory_table.updated",
          before,
          after,
        );
        return after;
      },
    );
  });
}

export async function publishStatutoryTable(
  context: ScopedTenantContext,
  actorUserId: string,
  versionId: StatutoryTableVersionId,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<StatutoryTableVersion> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.statutory_table.publish",
      { actor, versionId },
      async () => {
        const row = await loadRowForUpdate(tx, context, versionId);
        const before = toVersion(row);
        const next = publishStatutoryVersion(before, {
          today: businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK),
          actorId: actor,
          at: now.toISOString() as StatutoryTableVersion["createdAt"],
        });
        const [clash] = await tx
          .select({ id: statutoryRates.id })
          .from(statutoryRates)
          .where(
            and(
              eq(statutoryRates.tenantId, context.tenant.tenantId),
              eq(statutoryRates.type, before.type),
              eq(statutoryRates.effectiveFrom, before.effectiveFrom),
              eq(statutoryRates.status, "published"),
            ),
          )
          .limit(1);
        if (clash) throw sameDateConflict();
        let updated: Row | undefined;
        try {
          [updated] = await tx
            .update(statutoryRates)
            .set({
              status: "published",
              publishedAt: now,
              publishedBy: actor,
              updatedAt: now,
            })
            .where(
              and(
                eq(statutoryRates.tenantId, context.tenant.tenantId),
                eq(statutoryRates.id, versionId),
              ),
            )
            .returning();
        } catch (error) {
          // Lost the race for the published (type, date) unique index.
          if (uniqueViolation(error)) throw sameDateConflict();
          throw error;
        }
        if (!updated) throw new Error("Statutory table version was not stored");
        const after = toVersion(updated);
        if (after.status !== next.status)
          throw new Error("Statutory table version did not publish");
        await audit(
          tx,
          context,
          actor,
          now,
          "payroll.statutory_table.published",
          before,
          after,
        );
        return after;
      },
    );
  });
}

export async function archiveStatutoryTable(
  context: ScopedTenantContext,
  actorUserId: string,
  versionId: StatutoryTableVersionId,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<StatutoryTableVersion> {
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.statutory_table.archive",
      { actor, versionId },
      async () => {
        const row = await loadRowForUpdate(tx, context, versionId);
        const before = toVersion(row);
        archiveStatutoryVersion(before);
        const [updated] = await tx
          .update(statutoryRates)
          .set({ status: "archived", updatedAt: now })
          .where(
            and(
              eq(statutoryRates.tenantId, context.tenant.tenantId),
              eq(statutoryRates.id, versionId),
            ),
          )
          .returning();
        if (!updated) throw new Error("Statutory table version was not stored");
        const after = toVersion(updated);
        await audit(
          tx,
          context,
          actor,
          now,
          "payroll.statutory_table.archived",
          before,
          after,
        );
        return after;
      },
    );
  });
}
