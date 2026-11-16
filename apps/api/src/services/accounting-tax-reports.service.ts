// Tax reports as a revision chain (beads legend-5nhkp, legend-r3i8w, WS-07;
// PRD v1.7 §3.19 "Pajak"; docs/DECISIONS.md "Laporan pajak: pembetulan sebagai
// rantai revisi"). Decisions come from the contract (`transitionTaxReport`,
// `assertTaxTypeApplicable`); this file owns the locking and the persistence.
//
//   generate: draft only. Upsert on the draft key, never touches a final row.
//   finalize (one transaction), lock order draft → period → current report:
//     draft FOR UPDATE → fiscal_periods FOR SHARE (closed, and the period
//     version equals the version the draft was built from)
//     → current report of the key FOR UPDATE → revision = old + 1 (or 0)
//     → no-change guard → old row superseded → draft becomes final.
//     The finalize idempotency key is stored on the report; the same key on the
//     same report replays it, on another report it is IDEMPOTENCY_KEY_REUSED.
//   The partial unique indexes stay the safety net for a racing finalize (409);
//   the deferred chain trigger checks the pair at commit.
//   export: row FOR UPDATE; a superseded row answers 409 TAX_REPORT_SUPERSEDED;
//   an exported row returns its stored file (file_key is locked, no re-upload).
//   download: any non-draft row that has a file, superseded ones included.

import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  AccountingError,
  assertTaxTypeApplicable,
  coretaxExportFileName,
  generateTaxReportInputSchema,
  taxReportDownloadSchema,
  taxReportAmountIdr,
  taxReportExportSchema,
  taxReportSchema,
  taxReportExportedEvent,
  transitionTaxReport,
  type TaxReport,
  type TaxReportLine,
  type TaxReportStatus,
  type TaxReportType,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  idr,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { fiscalPeriods, legalEntities, taxReports } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { resolveCoretaxTaxIds } from "./accounting-coretax-tax-ids";
import {
  buildCoretaxXml,
  TAX_LINE_WARNING_PREFIX,
} from "./accounting-coretax-xml";
import {
  auditAccountingChange,
  requireLegalEntity,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";
import {
  defaultTaxLineSource,
  type TaxLineSource,
} from "./accounting-tax-line-source";
import type { StorageRuntime } from "./core-storage-runtime";
import { appendOutbox } from "./core-outbox";

export type { TaxLineSource } from "./accounting-tax-line-source";

type TaxReportRow = typeof taxReports.$inferSelect;

const SIGNED_URL_SECONDS = 300;

export function toTaxReport(row: TaxReportRow): TaxReport {
  return taxReportSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    type: row.type,
    period: row.period,
    amountIdr: row.amountIdr,
    lines: row.lines,
    status: row.status,
    exportFormat: row.exportFormat,
    fileKey: row.fileKey,
    generatedBy: row.generatedBy,
    generatedAt: row.generatedAt.toISOString(),
    finalizedBy: row.finalizedBy,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    exportedAt: row.exportedAt?.toISOString() ?? null,
    revisionNo: row.revisionNo,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    correctionReason: row.correctionReason,
    fiscalPeriodVersion: row.fiscalPeriodVersion,
    isCurrent: row.status !== "draft" && row.supersededAt === null,
  });
}

const stateOf = (row: TaxReportRow) => ({
  status: row.status as TaxReportStatus,
  supersededAt: row.supersededAt?.toISOString() ?? null,
});

const notFound = () => new AccountingError("TAX_REPORT_NOT_FOUND");

const conflict = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Laporan pajak periode ini baru saja berubah. Muat ulang lalu coba lagi.",
  );

/** A unique-index hit means a racing writer won: a retryable 409. */
function raceToConflict(error: unknown): unknown {
  if (finalizeKeyViolation(error)) return idempotencyKeyReused();
  return uniqueViolation(error) ? conflict() : error;
}

const idempotencyKeyReused = () =>
  new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was used to finalize a different tax report.",
  );

/** True when a unique violation hit the finalize idempotency index. */
function finalizeKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  return (
    candidate.constraint === "tax_reports_finalize_idempotency_key" ||
    finalizeKeyViolation(candidate.cause, depth + 1)
  );
}

/** Canonical JSON: object keys sorted, so key order never matters. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * A stored line in today's shape, for comparison only (the stored row is not
 * changed). Old lines have no `warnings` and may carry an auditor note in
 * `references` starting with "Peringatan:"; that note moves to `warnings`.
 */
function normalizeTaxLine(line: unknown): unknown {
  if (typeof line !== "object" || line === null) return line;
  const row = line as { references?: unknown; warnings?: unknown };
  const refs = Array.isArray(row.references)
    ? (row.references as string[])
    : [];
  const moved = refs
    .filter((ref) => ref.startsWith(TAX_LINE_WARNING_PREFIX))
    .map((ref) => ref.slice(TAX_LINE_WARNING_PREFIX.length).trim());
  return {
    ...row,
    references: refs.filter((ref) => !ref.startsWith(TAX_LINE_WARNING_PREFIX)),
    warnings: [...(Array.isArray(row.warnings) ? row.warnings : []), ...moved],
  };
}

const normalizedLinesJson = (value: unknown): string =>
  canonicalJson(Array.isArray(value) ? value.map(normalizeTaxLine) : value);

async function lockReport(
  tx: TenantTransaction,
  tenantId: string,
  taxReportId: string,
): Promise<TaxReportRow> {
  const [row] = await tx
    .select()
    .from(taxReports)
    .where(
      and(eq(taxReports.tenantId, tenantId), eq(taxReports.id, taxReportId)),
    )
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  return row;
}

// ---------------------------------------------------------------- list

export async function listTaxReports(
  context: ScopedTenantContext,
  query: {
    legalEntityId: string;
    type?: TaxReportType | undefined;
    status?: TaxReportStatus | undefined;
    includeSuperseded?: boolean | undefined;
  },
): Promise<{ data: TaxReport[] }> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const rows = await tx
      .select()
      .from(taxReports)
      .where(
        and(
          eq(taxReports.tenantId, tenantId),
          eq(taxReports.legalEntityId, query.legalEntityId),
          query.type ? eq(taxReports.type, query.type) : undefined,
          query.status ? eq(taxReports.status, query.status) : undefined,
          query.includeSuperseded ? undefined : isNull(taxReports.supersededAt),
        ),
      )
      .orderBy(
        desc(taxReports.period),
        asc(taxReports.type),
        desc(taxReports.createdAt),
        asc(taxReports.id),
      );
    return { data: rows.map(toTaxReport) };
  });
}

// ------------------------------------------------------------ generate

export async function generateTaxReport(
  context: ScopedTenantContext,
  actorId: UserId,
  input: unknown,
  deps: { lineSource?: TaxLineSource } = {},
): Promise<TaxReport> {
  assertTrustedScopedContext(context);
  const { legalEntityId, type, period } =
    generateTaxReportInputSchema.parse(input);
  const lineSource = deps.lineSource ?? defaultTaxLineSource;
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [entity] = await tx
      .select({ isPkp: legalEntities.isPkp })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.tenantId, tenantId),
          eq(legalEntities.id, legalEntityId),
        ),
      )
      .limit(1);
    if (!entity)
      throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
    assertTaxTypeApplicable(type, entity);

    const [fiscalPeriod] = await tx
      .select({ version: fiscalPeriods.version })
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          eq(fiscalPeriods.legalEntityId, legalEntityId),
          eq(fiscalPeriods.period, period),
        ),
      )
      .limit(1);
    if (!fiscalPeriod)
      throw new HttpError(404, "NOT_FOUND", "Fiscal period not found.");

    const lines: TaxReportLine[] = await lineSource(tx, {
      tenantId,
      legalEntityId,
      type,
      period,
    });
    const amountIdr = idr(taxReportAmountIdr(type, lines));
    const now = new Date();
    const [row] = await tx
      .insert(taxReports)
      .values({
        tenantId,
        legalEntityId,
        type,
        period,
        amountIdr,
        lines,
        status: "draft",
        generatedBy: actorId,
        generatedAt: now,
        fiscalPeriodVersion: fiscalPeriod.version,
      })
      .onConflictDoUpdate({
        target: [
          taxReports.tenantId,
          taxReports.legalEntityId,
          taxReports.type,
          taxReports.period,
        ],
        targetWhere: sql`${taxReports.status} = 'draft'`,
        set: {
          amountIdr,
          lines,
          fiscalPeriodVersion: fiscalPeriod.version,
          generatedBy: actorId,
          generatedAt: now,
          version: sql`${taxReports.version} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error("Tax report upsert returned no row.");
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.tax_report.generated",
      objectType: "tax_report",
      objectId: row.id,
      before: null,
      after: { type, count: lines.length },
    });
    return toTaxReport(row);
  }).catch((error: unknown) => {
    throw raceToConflict(error);
  });
}

// ------------------------------------------------------------ finalize

export async function finalizeTaxReport(
  context: ScopedTenantContext,
  actorId: UserId,
  taxReportId: string,
  body: {
    idempotencyKey: string;
    correctionReason?: string | undefined;
  },
): Promise<TaxReport> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // 1. the draft
    const draft = await lockReport(tx, tenantId, taxReportId);
    // Replay: the same key already filed this very report (a concurrent twin
    // waited on the lock above and lands here too). Nothing is written.
    if (draft.finalizeIdempotencyKey === body.idempotencyKey)
      return toTaxReport(draft);
    const [keyOwner] = await tx
      .select({ id: taxReports.id })
      .from(taxReports)
      .where(
        and(
          eq(taxReports.tenantId, tenantId),
          eq(taxReports.finalizeIdempotencyKey, body.idempotencyKey),
        ),
      )
      .limit(1);
    if (keyOwner && keyOwner.id !== draft.id) throw idempotencyKeyReused();
    if (draft.status !== "draft")
      throw new AccountingError("INVALID_TRANSITION");

    // 2. the period, shared: a reopen running at the same time waits for us
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          eq(fiscalPeriods.legalEntityId, draft.legalEntityId),
          eq(fiscalPeriods.period, draft.period),
        ),
      )
      .limit(1)
      .for("share");
    if (!period)
      throw new HttpError(404, "NOT_FOUND", "Fiscal period not found.");
    transitionTaxReport(stateOf(draft), "finalize", period);
    if (period.version !== draft.fiscalPeriodVersion)
      throw new AccountingError("TAX_REPORT_STALE");

    // 3. the report in force for the key, if any
    const [current] = await tx
      .select()
      .from(taxReports)
      .where(
        and(
          eq(taxReports.tenantId, tenantId),
          eq(taxReports.legalEntityId, draft.legalEntityId),
          eq(taxReports.type, draft.type),
          eq(taxReports.period, draft.period),
          ne(taxReports.status, "draft"),
          isNull(taxReports.supersededAt),
        ),
      )
      .limit(1)
      .for("update");

    // 4. nothing to correct: same amount and lines. The period version is not
    // compared: a reopen and re-close moves it without changing a figure, and
    // that empty correction must still be refused (the version only guards
    // staleness, step 2).
    if (
      current &&
      current.amountIdr === draft.amountIdr &&
      normalizedLinesJson(current.lines) === normalizedLinesJson(draft.lines)
    )
      throw new AccountingError("TAX_REPORT_NO_CHANGE");

    // 5. revision number and reason
    if (current && current.revisionNo === null)
      throw new Error("A non-draft tax report has no revision number.");
    const revisionNo = current ? (current.revisionNo ?? 0) + 1 : 0;
    const reason = body.correctionReason?.trim() ?? "";
    if (revisionNo >= 1 && reason === "")
      throw new AccountingError("TAX_REPORT_CORRECTION_REASON_REQUIRED");

    const lineTax = taxReportAmountIdr(
      draft.type as TaxReportType,
      draft.lines,
    );
    if (lineTax !== draft.amountIdr)
      throw new AccountingError("TAX_REPORT_AMOUNT_MISMATCH");

    // 6. old row first (frees the "one in force" index), then the draft
    const now = new Date();
    if (current)
      await tx
        .update(taxReports)
        .set({
          supersededAt: now,
          supersededById: draft.id,
          version: sql`${taxReports.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(eq(taxReports.tenantId, tenantId), eq(taxReports.id, current.id)),
        );
    const [finalized] = await tx
      .update(taxReports)
      .set({
        status: "final",
        revisionNo,
        supersedesId: current?.id ?? null,
        correctionReason: revisionNo >= 1 ? reason : null,
        finalizeIdempotencyKey: body.idempotencyKey,
        finalizedBy: actorId,
        finalizedAt: now,
        version: sql`${taxReports.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(eq(taxReports.tenantId, tenantId), eq(taxReports.id, draft.id)),
      )
      .returning();
    if (!finalized) throw new Error("Tax report finalize returned no row.");
    await auditAccountingChange(tx, context, {
      actorId,
      action: "accounting.tax_report.finalized",
      objectType: "tax_report",
      objectId: finalized.id,
      reason: revisionNo >= 1 ? reason : null,
      before: { status: "draft" },
      after: { status: "final", type: draft.type, revisionNo },
    });
    return toTaxReport(finalized);
  }).catch((error: unknown) => {
    throw raceToConflict(error);
  });
}

// -------------------------------------------------------------- export

async function signedFile(
  context: ScopedTenantContext,
  runtime: StorageRuntime,
  row: Pick<TaxReportRow, "id" | "fileKey">,
  fileName: string,
) {
  if (!row.fileKey) throw new Error("Tax report has no stored file.");
  const downloadUrl = await runtime.storage.signedGetUrl(context, {
    tenantId: context.tenant.tenantId,
    outletId: null,
    reference: row.id,
    key: row.fileKey,
    visibility: "private",
    expiresInSeconds: SIGNED_URL_SECONDS,
    downloadFileName: fileName,
  });
  return {
    taxReportId: row.id,
    fileKey: row.fileKey,
    fileName,
    downloadUrl,
    expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString(),
  };
}

function reportFileName(row: TaxReportRow): string {
  if (row.revisionNo === null) throw new AccountingError("INVALID_TRANSITION");
  return coretaxExportFileName(
    row.type as TaxReportType,
    row.period,
    row.revisionNo,
  );
}

export async function exportTaxReport(
  context: ScopedTenantContext,
  actorId: UserId,
  taxReportId: string,
  runtime: StorageRuntime,
) {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const stored = await withTenant(db, context, async (tx) => {
    const row = await lockReport(tx, tenantId, taxReportId);
    if (row.supersededAt !== null)
      throw new AccountingError("TAX_REPORT_SUPERSEDED", undefined, {
        supersededById: row.supersededById,
      });
    // Export never depends on the period state; the contract only needs a period for finalize.
    transitionTaxReport(stateOf(row), "export", { status: "closed" });
    // Already exported: the same file, no second upload and no write.
    if (row.fileKey !== null) return row;

    const fileName = reportFileName(row);
    const fileKey = `tax-reports/${row.id}/${fileName}`;
    const report = toTaxReport(row);
    const taxIds = await resolveCoretaxTaxIds(tx, tenantId, report);
    const xml = buildCoretaxXml(report, taxIds);
    const lookup = {
      tenantId,
      outletId: null,
      reference: row.id,
      key: fileKey,
    };
    await runtime.storage.put(context, {
      ...lookup,
      contentType: "application/xml",
      content: xml,
      visibility: "private",
    });
    try {
      const now = new Date();
      const [exported] = await tx
        .update(taxReports)
        .set({
          status: "exported",
          exportFormat: "coretax_xml",
          fileKey,
          exportedAt: now,
          version: sql`${taxReports.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(eq(taxReports.tenantId, tenantId), eq(taxReports.id, row.id)),
        )
        .returning();
      if (!exported) throw new Error("Tax report export returned no row.");
      await auditAccountingChange(tx, context, {
        actorId,
        action: "accounting.tax_report.exported",
        objectType: "tax_report",
        objectId: exported.id,
        before: { status: row.status },
        after: { status: "exported", type: row.type },
      });
      // The real NPWPs were opened for this file. Count only, never a value.
      await auditAccountingChange(tx, context, {
        actorId,
        action: "accounting.tax_report.npwp_opened",
        objectType: "tax_report",
        objectId: exported.id,
        before: null,
        after: {
          lineTaxIds: taxIds.lines.size,
          taxpayerIncluded: taxIds.taxpayer !== null,
        },
      });
      // The report lock and file-key replay guard allow exactly one event for
      // this report revision. Roll back the event with the export on failure.
      const event = taxReportExportedEvent.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: null,
        name: "tax_report.exported",
        version: 1,
        aggregateType: "tax_report",
        aggregateId: exported.id,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: { type: "user", id: actorId },
        deviceId: null,
        idempotencyKey: `tax_report.exported:${exported.id}`,
        payloadSchemaRef: taxReportExportedEvent.payloadSchemaRef,
        payload: {
          taxReportId: exported.id,
          legalEntityId: exported.legalEntityId,
          type: exported.type,
          period: exported.period,
          amountIdr: exported.amountIdr,
        },
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: "cloud-sync",
        direction: null,
        peerId: null,
      });
      return exported;
    } catch (error) {
      // The row stays unexported, so do not leave an orphan file behind.
      await Promise.allSettled([
        runtime.storage.delete(context, { ...lookup, visibility: "private" }),
      ]);
      throw error;
    }
  });
  return taxReportExportSchema.parse(
    await signedFile(context, runtime, stored, reportFileName(stored)),
  );
}

// ------------------------------------------------------------ download

export async function downloadTaxReport(
  context: ScopedTenantContext,
  taxReportId: string,
  runtime: StorageRuntime,
) {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const row = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(taxReports)
      .where(
        and(eq(taxReports.tenantId, tenantId), eq(taxReports.id, taxReportId)),
      )
      .limit(1);
    if (!found) throw notFound();
    return found;
  });
  if (row.status === "draft") throw new AccountingError("INVALID_TRANSITION");
  if (row.fileKey === null)
    throw new HttpError(409, "CONFLICT", "Laporan ini belum diekspor.");
  return taxReportDownloadSchema.parse({
    ...(await signedFile(context, runtime, row, reportFileName(row))),
    revisionNo: row.revisionNo,
    supersededById: row.supersededById,
  });
}
