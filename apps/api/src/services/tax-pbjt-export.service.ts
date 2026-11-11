// PBJT monthly recap as a stored CSV (brief in4m-pbjt-export). The file is
// rendered from the same recap object `getPbjtMonthlyRecap` returns, so the CSV
// total and the stored `amount_idr` are that recap's `totalTaxIdr` and nothing
// recomputed. Each export is an append-only history row; the same idempotency
// key replays the first row with a fresh signed URL and stores no second file.
// The `tax_reports` row is only read (to link the export), never changed.

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  createUlid,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  pbjtExportFileName,
  pbjtExportRequestSchema,
  pbjtExportResultSchema,
  pbjtRecapToCsv,
  type PbjtExportRequest,
} from "@starter/shared/tax";
import { db } from "../db";
import { outlets, taxReportExports, taxReports } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { uniqueViolation } from "./accounting-shared";
import { recordAudit } from "./core-audit";
import { getPbjtMonthlyRecap } from "./tax.service";

const SIGNED_URL_SECONDS = 300;

type ExportRow = typeof taxReportExports.$inferSelect;

export async function exportPbjtMonthlyRecap(
  runtime: { storage: ObjectStorage },
  context: ScopedTenantContext,
  actorUserId: string,
  body: PbjtExportRequest,
  now = new Date(),
) {
  const actor = userIdSchema.parse(actorUserId);
  const input = pbjtExportRequestSchema.parse(body);
  const tenantId = context.tenant.tenantId;

  // Asserts accounting.tax_report.manage on the outlet and the caller's reach
  // before anything is read or stored (also on a replay).
  const recap = await getPbjtMonthlyRecap(
    context,
    actor,
    { outletId: input.outletId, period: input.period },
    now,
  );

  const findByKey = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
    tx
      .select()
      .from(taxReportExports)
      .where(
        and(
          eq(taxReportExports.tenantId, tenantId),
          eq(taxReportExports.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

  const replay = (row: ExportRow) => {
    if (row.outletId !== input.outletId || row.period !== input.period)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was used for another export.",
      );
    return signedResult(runtime, context, row, now);
  };

  const [existing] = await withTenant(db, context, findByKey);
  if (existing) return replay(existing);

  const exportId = randomUUID();
  const fileName = pbjtExportFileName(input.period, input.outletId);
  const fileKey = `tax-report-exports/${exportId}/${fileName}`;
  const lookup = {
    tenantId,
    outletId: input.outletId,
    reference: exportId,
    key: fileKey,
  };
  await runtime.storage.put(context, {
    ...lookup,
    contentType: "text/csv; charset=utf-8",
    content: pbjtRecapToCsv(recap),
    visibility: "private",
  });

  let saved: ExportRow;
  try {
    saved = await withTenant(db, context, async (tx) => {
      const [outlet] = await tx
        .select({ legalEntityId: outlets.legalEntityId })
        .from(outlets)
        .where(
          and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
        )
        .limit(1);
      if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      // Link to the current (final or exported, not superseded) PBJT report of
      // the outlet's legal entity for the period, if there is one.
      const [report] = await tx
        .select({ id: taxReports.id })
        .from(taxReports)
        .where(
          and(
            eq(taxReports.tenantId, tenantId),
            eq(taxReports.legalEntityId, outlet.legalEntityId),
            eq(taxReports.type, "pbjt"),
            eq(taxReports.period, input.period),
            ne(taxReports.status, "draft"),
            isNull(taxReports.supersededAt),
          ),
        )
        .limit(1);
      const [row] = await tx
        .insert(taxReportExports)
        .values({
          id: exportId,
          tenantId,
          outletId: input.outletId,
          legalEntityId: outlet.legalEntityId,
          taxReportId: report?.id ?? null,
          type: "pbjt",
          period: input.period,
          format: "csv",
          amountIdr: recap.totalTaxIdr,
          rowCount: recap.rows.length,
          fileKey,
          fileName,
          idempotencyKey: input.idempotencyKey,
          generatedBy: actor,
        })
        .returning();
      if (!row) throw new Error("PBJT export insert returned no row.");
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: input.outletId,
          actorType: "user",
          actorId: actor,
          deviceId: null,
          action: "tax.pbjt_export.created",
          objectType: "tax_report_export",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: {},
            after: {
              period: input.period,
              amountIdr: recap.totalTaxIdr,
              rowCount: recap.rows.length,
              taxReportId: row.taxReportId,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        // Business facts, not secrets: keep them readable in the audit trail.
        ["period", "amountIdr", "rowCount", "taxReportId"],
      );
      return row;
    });
  } catch (error) {
    // No row owns the file, so do not leave an orphan behind.
    await Promise.allSettled([
      runtime.storage.delete(context, { ...lookup, visibility: "private" }),
    ]);
    // A racing request with the same key won: replay its row.
    if (uniqueViolation(error)) {
      const [winner] = await withTenant(db, context, findByKey);
      if (winner) return replay(winner);
    }
    throw error;
  }
  return signedResult(runtime, context, saved, now);
}

async function signedResult(
  runtime: { storage: ObjectStorage },
  context: ScopedTenantContext,
  row: ExportRow,
  now: Date,
) {
  const downloadUrl = await runtime.storage.signedGetUrl(context, {
    tenantId: context.tenant.tenantId,
    outletId: outletIdSchema.parse(row.outletId),
    reference: row.id,
    key: row.fileKey,
    visibility: "private",
    expiresInSeconds: SIGNED_URL_SECONDS,
    downloadFileName: row.fileName,
  });
  return pbjtExportResultSchema.parse({
    exportId: row.id,
    taxReportId: row.taxReportId,
    outletId: row.outletId,
    period: row.period,
    amountIdr: row.amountIdr,
    rowCount: row.rowCount,
    fileKey: row.fileKey,
    fileName: row.fileName,
    downloadUrl,
    expiresAt: new Date(
      now.getTime() + SIGNED_URL_SECONDS * 1000,
    ).toISOString(),
  });
}
