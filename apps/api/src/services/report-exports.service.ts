// Report export jobs (WS-11 F12, bead legend-ay6e6; contract
// `reportExportSchema`, `reportExportGate` in `@starter/shared/dashboard`;
// PRD v1.7 §3.36 "Ekspor", DASH-04).
//
// Lifecycle:
//   POST  -> `queued` (aggregate) or `pending_approval` (personal data; a WS-01
//            `personal_data_export` approval chain is opened in the same
//            transaction, no row leaves the database).
//   sweep -> pending_approval: approved -> queued; rejected / expired /
//            cancelled -> rejected.
//         -> queued: generating -> ready (file) | failed (errorCode).
//         -> ready past `expires_at` -> expired (file bytes cleared).
//
// Every generation re-resolves the REQUESTER's access from the database and
// runs the report under it (`userViewerAccess` + `resolveViewerFor`), so a
// permission or outlet revoked after the request fails the job instead of
// leaking it. A download re-checks the same rule for the caller and that the
// caller's outlet reach still covers the outlets in the file; anything else
// answers 404, like another user's or another tenant's job.
//
// Audit: request, generation and download are audited; `sensitiveAccess` is
// the job's personal-data flag. Snapshots carry ids, codes and counts only,
// never row values.
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  type CursorPageQuery,
  type OutletScopeData,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  REPORT_BUILDER_MAX_ROWS,
  REPORT_EXPORT_APPROVAL_ACTION,
  REPORT_EXPORT_RETENTION_DAYS,
  reportBuilderQuerySchema,
  reportByCode,
  reportExportGate,
  reportExportPageSchema,
  reportExportQuerySchema,
  reportExportSchema,
  reportMetricByCode,
  reportRunInputSchema,
  type ReportBuilderQuery,
  type ReportDefinition,
  type ReportErrorCode,
  type ReportExport,
  type ReportExportFormat,
  type ReportExportPage,
  type ReportExportQuery,
  type ReportResult,
} from "@starter/shared/dashboard";
import { db } from "../db";
import { outlets, reportExports, savedReports } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  resolveViewerFor,
  userViewerAccess,
  type ViewerAccess,
} from "../routes/report-viewer";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { recordAudit } from "./audit-writer";
import { appendOutbox } from "./core-outbox";
import {
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";
import {
  EXPORT_CONTENT_TYPES,
  exportTableOf,
  renderExportFile,
} from "./report-export-files";
import type { MetricViewer } from "./metrics-query.service";
import {
  previewReport,
  reportHttpError,
  runReport,
} from "./report-run.service";

export const REPORT_EXPORT_SOURCE_MODULE = "report";
export const REPORT_EXPORT_OBJECT_TYPE = "report_export";
/** Jobs one sweep generates per tenant; the rest wait for the next tick. */
export const REPORT_EXPORT_BATCH = 10;
/** A job `generating` longer than this lost its worker (a render takes seconds). */
export const REPORT_EXPORT_GENERATING_TIMEOUT_MS = 15 * 60 * 1000;
/** Generation claims one job gets before a timeout fails it instead. */
export const REPORT_EXPORT_MAX_ATTEMPTS = 3;

type Row = typeof reportExports.$inferSelect;

/**
 * Every column except the file bytes, which are swapped for a one-byte marker
 * (non-null means "has a file"). A read that does not serve the file never
 * pulls it from the database.
 */
const metadataColumns = {
  ...getTableColumns(reportExports),
  fileContent: sql<Buffer | null>`CASE WHEN ${reportExports.fileContent} IS NULL THEN NULL ELSE '\\x00'::bytea END`,
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What one export reads: a catalog report, or a saved builder query. */
export type ExportSource =
  | { kind: "report"; report: ReportDefinition }
  | {
      kind: "saved";
      savedReportId: string;
      name: string;
      query: ReportBuilderQuery;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

function tenantWide(tenant: TenantContext): ScopedTenantContext {
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

// ---- Mapping ------------------------------------------------------------------

export function toReportExport(row: Row): ReportExport {
  const ready = row.status === "ready" && row.fileContent !== null;
  return reportExportSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    reportCode: row.reportCode,
    savedReportId: row.savedReportId,
    format: row.format,
    query: row.query,
    containsPersonalData: row.containsPersonalData,
    approvalRequestId: row.approvalRequestId,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    file: ready
      ? {
          downloadPath: `/api/reports/exports/${row.id}/file`,
          sizeBytes: row.fileSizeBytes ?? 0,
          rowCount: row.rowCount ?? 0,
          expiresAt: (row.expiresAt ?? new Date()).toISOString(),
        }
      : null,
    errorCode: row.errorCode,
  });
}

/** Builder query of a saved-report export: saved metrics, export selection. */
export function savedExportQuery(
  saved: ReportBuilderQuery,
  query: ReportExportQuery,
): ReportBuilderQuery {
  const parsed = reportBuilderQuerySchema.safeParse({
    metricCodes: saved.metricCodes,
    ...query,
    limit: REPORT_BUILDER_MAX_ROWS,
  });
  if (!parsed.success) throw reportHttpError("REPORT_FILTER_NOT_SUPPORTED");
  return parsed.data;
}

/** The source reports whose permissions admit a read of `source`. */
export function sourceReports(source: ExportSource): ReportDefinition[] {
  if (source.kind === "report") return [source.report];
  const reports = new Map<string, ReportDefinition>();
  for (const code of source.query.metricCodes) {
    const report = reportByCode(reportBuilderMetricSource(code) ?? "");
    if (report === undefined) throw reportHttpError("REPORT_NOT_PERMITTED");
    reports.set(report.code, report);
  }
  return [...reports.values()];
}

function reportBuilderMetricSource(code: string): string | undefined {
  return reportMetricByCode.get(code)?.sourceReport.reportCode;
}

// ---- Gate ---------------------------------------------------------------------

type GateResult =
  | { action: "queue"; containsPersonalData: boolean }
  | { action: "request_approval"; containsPersonalData: true };

/**
 * `reportExportGate` for `access` plus the outlet check: the requested
 * outlets must lie in the access's reach for every source report (403).
 * Returns the viewer context the run uses.
 */
export async function gateExport(
  access: ViewerAccess,
  source: ExportSource,
  format: ReportExportFormat,
  query: ReportExportQuery,
  approval: "none" | "approved",
): Promise<{
  gate: GateResult;
  context: ScopedTenantContext;
  viewer: MetricViewer;
}> {
  const decision = reportExportGate({
    report: source.kind === "report" ? source.report : null,
    query:
      source.kind === "report"
        ? query
        : { ...query, metricCodes: source.query.metricCodes },
    format,
    permissions: new Set(access.snapshot.permissions),
    approval,
  });
  if (decision.action === "reject") throw reportHttpError(decision.code);
  const { context, viewer } = await resolveViewerFor(
    access,
    sourceReports(source).map((report) => ({ kind: "report", report })),
  );
  outletIdsForQuery(context.outletScope, query.outletIds);
  return { gate: decision, context, viewer };
}

// ---- Create -------------------------------------------------------------------

export type CreateExportInput = {
  readonly source: ExportSource;
  readonly format: ReportExportFormat;
  readonly query: ReportExportQuery;
  readonly idempotencyKey?: string;
  /** Set by the scheduler: the slot this job delivers. */
  readonly schedule?: { readonly id: string; readonly scheduledFor: Date };
};

async function auditExport(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  action: string,
  actor: { type: "user"; id: string } | { type: "system" },
  after: Record<string, unknown>,
): Promise<void> {
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: actor.type,
      actorId: actor.type === "user" ? actor.id : null,
      deviceId: null,
      action,
      objectType: REPORT_EXPORT_OBJECT_TYPE,
      objectId: row.id,
      // A personal-data job is sensitive access, which always names why.
      reason: row.containsPersonalData ? "Ekspor data pribadi (DASH-04)" : null,
      before: null,
      after: {
        reportCode: row.reportCode,
        savedReportId: row.savedReportId,
        scheduleId: row.scheduleId,
        format: row.format,
        containsPersonalData: row.containsPersonalData,
        ...after,
      },
      sensitiveAccess: row.containsPersonalData,
    },
    { tx, context },
  );
}

/**
 * Stores the job the gate admitted. The caller already ran `gateExport` for
 * the requester. A replayed idempotency key returns the first job unchanged.
 */
export async function createReportExport(
  tenant: TenantContext,
  requestedBy: string,
  input: CreateExportInput,
  gate: GateResult,
  now = new Date(),
): Promise<{ job: ReportExport; replayed: boolean }> {
  const context = tenantWide(tenant);
  return withTenant(db, context, async (tx) => {
    if (input.idempotencyKey !== undefined) {
      const [existing] = await tx
        .select()
        .from(reportExports)
        .where(
          and(
            eq(reportExports.tenantId, tenant.tenantId),
            eq(reportExports.requestedBy, requestedBy),
            eq(reportExports.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing !== undefined)
        return { job: toReportExport(existing), replayed: true };
    }
    const id = crypto.randomUUID();
    let approvalRequestId: string | null = null;
    if (gate.action === "request_approval") {
      const opened = await openApprovalRequest(tx, context, {
        sourceModule: REPORT_EXPORT_SOURCE_MODULE,
        actionType: REPORT_EXPORT_APPROVAL_ACTION,
        objectType: REPORT_EXPORT_OBJECT_TYPE,
        objectId: id,
        amountIdr: null,
        outletId: null,
        requestedBy,
        source: "user",
        requestReason: `Ekspor data pribadi: ${titleOf(input.source)}`.slice(
          0,
          500,
        ),
        payload: {
          reportCode:
            input.source.kind === "report" ? input.source.report.code : null,
          savedReportId:
            input.source.kind === "saved" ? input.source.savedReportId : null,
          format: input.format,
          period: input.query.period,
        },
        alwaysRequire: true,
        now,
      });
      if (!opened.required)
        throw new Error("A personal-data export always needs an approval");
      approvalRequestId = opened.chainId;
    }
    const [row] = await tx
      .insert(reportExports)
      .values({
        id,
        tenantId: tenant.tenantId,
        requestedBy,
        reportCode:
          input.source.kind === "report" ? input.source.report.code : null,
        savedReportId:
          input.source.kind === "saved" ? input.source.savedReportId : null,
        scheduleId: input.schedule?.id ?? null,
        scheduledFor: input.schedule?.scheduledFor ?? null,
        format: input.format,
        query: input.query,
        containsPersonalData: gate.containsPersonalData,
        approvalRequestId,
        status:
          gate.action === "request_approval" ? "pending_approval" : "queued",
        idempotencyKey: input.idempotencyKey ?? null,
        requestedAt: now,
      })
      .returning();
    if (row === undefined) throw new Error("Export insert returned no row");
    await auditExport(
      tx,
      context,
      row,
      "report_export.requested",
      { type: "user", id: requestedBy },
      { status: row.status, approvalRequestId },
    );
    return { job: toReportExport(row), replayed: false };
  });
}

function titleOf(source: ExportSource): string {
  return source.kind === "report" ? source.report.name : source.name;
}

// ---- Read ---------------------------------------------------------------------

async function ownRow(
  tx: Tx,
  context: ScopedTenantContext,
  requestedBy: string,
  id: string,
): Promise<Row> {
  const [row] = await tx
    .select(metadataColumns)
    .from(reportExports)
    .where(
      and(
        eq(reportExports.tenantId, context.tenant.tenantId),
        eq(reportExports.requestedBy, requestedBy),
        eq(reportExports.id, id),
      ),
    );
  if (row === undefined)
    throw new HttpError(404, "NOT_FOUND", "Ekspor tidak ditemukan.");
  return row;
}

export function getReportExport(
  tenant: TenantContext,
  requestedBy: string,
  id: string,
): Promise<ReportExport> {
  const context = tenantWide(tenant);
  return withTenant(db, context, async (tx) =>
    toReportExport(await ownRow(tx, context, requestedBy, id)),
  );
}

export async function listReportExports(
  tenant: TenantContext,
  requestedBy: string,
  query: CursorPageQuery,
): Promise<ReportExportPage> {
  let after: { at: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    }
    const [at, id] = keys;
    if (typeof at !== "string" || typeof id !== "string")
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    after = { at, id };
  }
  const context = tenantWide(tenant);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        ...metadataColumns,
        cursorAt: sql<string>`${reportExports.requestedAt}::text`,
      })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.requestedBy, requestedBy),
          after === undefined
            ? sql`TRUE`
            : sql`(${reportExports.requestedAt}, ${reportExports.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(reportExports.requestedAt), desc(reportExports.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return reportExportPageSchema.parse({
    data: page.map(toReportExport),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCursor([last.cursorAt, last.id])
          : null,
    },
  });
}

// ---- Source of a stored job ---------------------------------------------------

async function sourceOfRow(tx: Tx, row: Row): Promise<ExportSource> {
  if (row.reportCode !== null) {
    const report = reportByCode(row.reportCode);
    if (report === undefined) throw reportHttpError("REPORT_NOT_FOUND");
    return { kind: "report", report };
  }
  const [saved] = await tx
    .select({
      id: savedReports.id,
      name: savedReports.name,
      query: savedReports.query,
    })
    .from(savedReports)
    .where(
      and(
        eq(savedReports.tenantId, row.tenantId),
        eq(savedReports.id, row.savedReportId ?? ""),
      ),
    );
  if (saved === undefined) throw reportHttpError("SAVED_REPORT_NOT_FOUND");
  return {
    kind: "saved",
    savedReportId: saved.id,
    name: saved.name,
    query: reportBuilderQuerySchema.parse(saved.query),
  };
}

// ---- Download -----------------------------------------------------------------

/** "all" or the outlets a file covers. */
type Coverage = "all" | readonly string[];

function coverageOf(result: ReportResult): Coverage {
  return result.outletFilter.kind === "all"
    ? "all"
    : [...result.outletFilter.outletIds];
}

function covers(scope: OutletScopeData, coverage: Coverage): boolean {
  if (scope.kind === "tenant") return true;
  if (coverage === "all") return false;
  const reach = new Set<string>(scope.outletIds);
  return coverage.every((id) => reach.has(id));
}

export type ExportFile = {
  readonly content: Buffer;
  readonly contentType: string;
  readonly fileName: string;
};

/**
 * The file of the caller's own ready job. 404 when the job is not theirs, or
 * when they no longer may open its source over every outlet in the file;
 * 409 EXPORT_NOT_READY before it is ready; 410 EXPORT_EXPIRED after.
 */
export async function downloadReportExport(
  access: ViewerAccess,
  id: string,
  now = new Date(),
): Promise<ExportFile> {
  const context = tenantWide(access.tenant);
  const row = await withTenant(db, context, (tx) =>
    ownRow(tx, context, access.userId, id),
  );
  const hidden = () =>
    new HttpError(404, "NOT_FOUND", "Ekspor tidak ditemukan.");
  if (
    row.status === "expired" ||
    (row.status === "ready" && row.expiresAt !== null && row.expiresAt <= now)
  )
    throw reportHttpError("EXPORT_EXPIRED");
  if (row.status !== "ready" || row.fileContent === null)
    throw reportHttpError("EXPORT_NOT_READY");
  const source = await withTenant(db, context, (tx) => sourceOfRow(tx, row));
  const query = reportExportQuerySchema.parse(row.query);
  let scope: OutletScopeData;
  let viewer: MetricViewer;
  try {
    const gated = await gateExport(
      access,
      source,
      row.format as ReportExportFormat,
      query,
      row.containsPersonalData ? "approved" : "none",
    );
    scope = gated.context.outletScope;
    viewer = gated.viewer;
  } catch {
    throw hidden();
  }
  if (!covers(scope, (row.outletIds as Coverage | null) ?? "all"))
    throw hidden();
  // A file made for a full viewer never reaches an aggregate-only caller.
  if (row.viewer !== "aggregate" && viewer !== "full") throw hidden();
  // The bytes are read only now, after every access check passed.
  const content = await withTenant(db, context, async (tx) => {
    const [file] = await tx
      .select({ fileContent: reportExports.fileContent })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.tenantId, context.tenant.tenantId),
          eq(reportExports.id, row.id),
        ),
      );
    if (file?.fileContent == null) throw reportHttpError("EXPORT_NOT_READY");
    await auditExport(
      tx,
      context,
      row,
      "report_export.downloaded",
      { type: "user", id: access.userId },
      { rowCount: row.rowCount },
    );
    return file.fileContent;
  });
  const format = row.format as keyof typeof EXPORT_CONTENT_TYPES;
  return {
    content,
    contentType: EXPORT_CONTENT_TYPES[format],
    fileName: `laporan-${row.id.slice(0, 8)}.${format}`,
  };
}

// ---- Generation ---------------------------------------------------------------

async function outletLabels(
  context: ScopedTenantContext,
  result: ReportResult,
): Promise<Map<string, string>> {
  if (!result.groupBy.includes("outlet")) return new Map();
  const ids = [
    ...new Set(
      result.rows.flatMap((row) =>
        row.dimensions.filter((d) => d.key === "outlet").map((d) => d.value),
      ),
    ),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return new Map();
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ id: outlets.id, name: outlets.name })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          inArray(outlets.id, ids as never[]),
        ),
      ),
  );
  return new Map(rows.map((row) => [String(row.id), row.name]));
}

/** Runs the job's source under the requester's current access. */
async function generate(
  tenant: TenantContext,
  row: Row,
  source: ExportSource,
  now: Date,
): Promise<{
  content: Buffer;
  rowCount: number;
  coverage: Coverage;
  viewer: MetricViewer;
}> {
  const access = await userViewerAccess(tenant, row.requestedBy);
  const query = reportExportQuerySchema.parse(row.query);
  const format = row.format as ReportExportFormat;
  const { gate, context, viewer } = await gateExport(
    access,
    source,
    format,
    query,
    row.containsPersonalData ? "approved" : "none",
  );
  // The job was admitted with its own personal-data flag; if the source now
  // says otherwise (a saved query edited since), no file is made.
  if (gate.action !== "queue")
    throw reportHttpError("EXPORT_PII_APPROVAL_REQUIRED");
  const result =
    source.kind === "report"
      ? await runReport(
          context,
          reportRunInputSchema.parse({
            reportCode: source.report.code,
            ...query,
            limit: REPORT_BUILDER_MAX_ROWS,
          }),
          { viewer, now },
        )
      : await previewReport(context, savedExportQuery(source.query, query), {
          viewer,
          now,
        });
  const table = exportTableOf(result, {
    title: titleOf(source),
    labels: await outletLabels(context, result),
  });
  return {
    content: await renderExportFile(format, table),
    rowCount: result.rows.length,
    coverage: coverageOf(result),
    viewer,
  };
}

function errorCodeOf(error: unknown): ReportErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === "REPORT_NOT_PERMITTED" ||
    code === "REPORT_NOT_FOUND" ||
    code === "SAVED_REPORT_NOT_FOUND" ||
    code === "REPORT_FILTER_NOT_SUPPORTED" ||
    code === "EXPORT_FORMAT_NOT_SUPPORTED" ||
    code === "EXPORT_PII_APPROVAL_REQUIRED"
  )
    return code;
  // Outlet out of scope and any other refusal: the requester may not read it.
  if (code === "OUTLET_OUT_OF_SCOPE" || code === "FORBIDDEN")
    return "REPORT_NOT_PERMITTED";
  return "REPORT_QUERY_INVALID";
}

/** Generates one queued job; returns its final status. */
export async function generateReportExport(
  tenant: TenantContext,
  id: string,
  now = new Date(),
): Promise<"ready" | "failed" | "skipped"> {
  const context = tenantWide(tenant);
  const claimed = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(reportExports)
      .set({
        status: "generating",
        startedAt: now,
        attempts: sql`${reportExports.attempts} + 1`,
      })
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.id, id),
          eq(reportExports.status, "queued"),
        ),
      )
      .returning();
    return row === undefined
      ? null
      : { row, source: await sourceOfRow(tx, row).catch((error) => error) };
  });
  if (claimed === null) return "skipped";
  let outcome:
    | {
        ok: true;
        content: Buffer;
        rowCount: number;
        coverage: Coverage;
        viewer: MetricViewer;
      }
    | { ok: false; code: ReportErrorCode };
  try {
    if (claimed.source instanceof Error) throw claimed.source;
    outcome = {
      ok: true,
      ...(await generate(tenant, claimed.row, claimed.source, now)),
    };
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "REPORT_QUERY_INVALID")
      logger.error(
        { errName: (error as Error)?.name, exportId: id },
        "Report export generation failed",
      );
    outcome = { ok: false, code };
  }
  const completedAt = new Date(Math.max(now.getTime(), Date.now()));
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(reportExports)
      .set(
        outcome.ok
          ? {
              status: "ready",
              completedAt,
              fileContent: outcome.content,
              fileSizeBytes: outcome.content.length,
              rowCount: outcome.rowCount,
              outletIds: outcome.coverage,
              viewer: outcome.viewer,
              expiresAt: new Date(
                completedAt.getTime() + REPORT_EXPORT_RETENTION_DAYS * DAY_MS,
              ),
            }
          : { status: "failed", completedAt, errorCode: outcome.code },
      )
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.id, id),
          eq(reportExports.status, "generating"),
        ),
      )
      .returning();
    if (row === undefined) return "skipped";
    await auditExport(
      tx,
      context,
      row,
      outcome.ok ? "report_export.generated" : "report_export.failed",
      { type: "system" },
      outcome.ok ? { rowCount: outcome.rowCount } : { errorCode: outcome.code },
    );
    if (outcome.ok && row.scheduleId !== null)
      await emitReportDelivered(tx, context, row, completedAt);
    if (outcome.ok && row.savedReportId !== null)
      await tx
        .update(savedReports)
        .set({ lastRunAt: completedAt })
        .where(
          and(
            eq(savedReports.tenantId, tenant.tenantId),
            eq(savedReports.id, row.savedReportId),
          ),
        );
    return outcome.ok ? "ready" : "failed";
  });
}

export const REPORT_DELIVERED_EVENT = "report_export.delivered";

/**
 * A scheduled job's file is ready: one outbox event for the notification
 * consumer (worker/notification-adapters.ts `report_export.delivered`), which
 * re-reads the job and notifies its recipient in-app and by email. Ids only;
 * the event carries no figure.
 */
async function emitReportDelivered(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  now: Date,
): Promise<void> {
  const event = eventEnvelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    name: REPORT_DELIVERED_EVENT,
    version: 1,
    aggregateType: "report_export",
    aggregateId: row.id,
    sequence: 1,
    occurredAt: now.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${REPORT_DELIVERED_EVENT}:${row.id}`,
    payloadSchemaRef: `${REPORT_DELIVERED_EVENT}.v1`,
    payload: { exportId: row.id },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: "notification",
    direction: null,
    peerId: null,
  });
}

export type ExportSweepResult = {
  approved: number;
  rejected: number;
  ready: number;
  failed: number;
  expired: number;
  /** Ids of jobs that turned ready in this sweep (the scheduler notifies). */
  readyIds: string[];
};

/**
 * A worker that died mid-render leaves its job `generating` for good. After
 * the timeout the job goes back to `queued` (the sweep then claims it again),
 * or to `failed` once it has used its attempts. Returns the jobs failed.
 */
async function recoverStuckExports(
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  const stale = and(
    eq(reportExports.tenantId, context.tenant.tenantId),
    eq(reportExports.status, "generating"),
    lt(
      reportExports.startedAt,
      new Date(now.getTime() - REPORT_EXPORT_GENERATING_TIMEOUT_MS),
    ),
  );
  return withTenant(db, context, async (tx) => {
    const requeued = await tx
      .update(reportExports)
      .set({ status: "queued", startedAt: null })
      .where(and(stale, lt(reportExports.attempts, REPORT_EXPORT_MAX_ATTEMPTS)))
      .returning();
    for (const row of requeued)
      await auditExport(
        tx,
        context,
        row,
        "report_export.requeued",
        { type: "system" },
        { attempts: row.attempts },
      );
    const failed = await tx
      .update(reportExports)
      .set({
        status: "failed",
        completedAt: now,
        // The shared error list has no "timed out"; this is the generic one.
        errorCode: "REPORT_QUERY_INVALID",
      })
      .where(
        and(stale, gte(reportExports.attempts, REPORT_EXPORT_MAX_ATTEMPTS)),
      )
      .returning();
    for (const row of failed)
      await auditExport(
        tx,
        context,
        row,
        "report_export.failed",
        { type: "system" },
        { errorCode: "REPORT_QUERY_INVALID", attempts: row.attempts },
      );
    return failed.length;
  });
}

/**
 * One sweep for one tenant: settle approvals, generate up to
 * `REPORT_EXPORT_BATCH` queued jobs, expire old files.
 */
export async function sweepReportExports(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<ExportSweepResult> {
  const tenant = context.tenant;
  const wide = tenantWide(tenant);
  const result: ExportSweepResult = {
    approved: 0,
    rejected: 0,
    ready: 0,
    failed: 0,
    expired: 0,
    readyIds: [],
  };
  const pending = await withTenant(db, wide, (tx) =>
    tx
      .select({
        id: reportExports.id,
        chainId: reportExports.approvalRequestId,
      })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.status, "pending_approval"),
        ),
      )
      .limit(100),
  );
  for (const job of pending) {
    if (job.chainId === null) continue;
    await withTenant(db, wide, async (tx) => {
      const outcome = await resolveApprovalChainOutcome(tx, wide, {
        chainId: job.chainId ?? "",
        sourceModule: REPORT_EXPORT_SOURCE_MODULE,
        now,
      });
      if (outcome === "pending") return;
      const [row] = await tx
        .update(reportExports)
        .set({ status: outcome === "approved" ? "queued" : "rejected" })
        .where(
          and(
            eq(reportExports.tenantId, tenant.tenantId),
            eq(reportExports.id, job.id),
            eq(reportExports.status, "pending_approval"),
          ),
        )
        .returning();
      if (row === undefined) return;
      if (outcome === "approved") result.approved += 1;
      else result.rejected += 1;
      await auditExport(
        tx,
        wide,
        row,
        outcome === "approved"
          ? "report_export.approved"
          : "report_export.rejected",
        { type: "system" },
        { approvalOutcome: outcome },
      );
    });
  }
  result.failed += await recoverStuckExports(wide, now);
  const queued = await withTenant(db, wide, (tx) =>
    tx
      .select({ id: reportExports.id })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.status, "queued"),
        ),
      )
      .orderBy(reportExports.requestedAt)
      .limit(REPORT_EXPORT_BATCH),
  );
  for (const job of queued) {
    const status = await generateReportExport(tenant, job.id, now);
    if (status === "ready") {
      result.ready += 1;
      result.readyIds.push(job.id);
    } else if (status === "failed") result.failed += 1;
  }
  const expired = await withTenant(db, wide, (tx) =>
    tx
      .update(reportExports)
      .set({ status: "expired", fileContent: null })
      .where(
        and(
          eq(reportExports.tenantId, tenant.tenantId),
          eq(reportExports.status, "ready"),
          lt(reportExports.expiresAt, now),
        ),
      )
      .returning({ id: reportExports.id }),
  );
  result.expired = expired.length;
  return result;
}
