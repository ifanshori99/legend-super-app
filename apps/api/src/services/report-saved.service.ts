// Saved builder reports (WS-11 F12, bead legend-ay6e6; contract
// `savedReportSchema` in `@starter/shared/dashboard`).
//
// - A saved report is private to its owner: every read and write filters on
//   `owner_user_id` = the verified caller in SQL, under tenant RLS. Another
//   user's or another tenant's id answers 404 SAVED_REPORT_NOT_FOUND, never
//   403, so ids cannot be probed.
// - The route checks the caller may read the query (metrics, splits, outlets)
//   before it reaches here; the stored query is parsed again on every read so
//   a row never leaves the server in a shape the contract refuses.
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  type CursorPageQuery,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  reportBuilderQuerySchema,
  savedReportPageSchema,
  savedReportSchema,
  type CreateSavedReportInput,
  type ReportBuilderQuery,
  type SavedReport,
  type SavedReportPage,
  type UpdateSavedReportInput,
} from "@starter/shared/dashboard";
import { db } from "../db";
import { savedReports } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { reportHttpError } from "./report-run.service";

type Row = typeof savedReports.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function toSavedReport(row: Row): SavedReport {
  return savedReportSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    query: row.query,
    ownerUserId: row.ownerUserId,
    status: row.status,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** The owner's row, locked when `forUpdate`; 404 when it is not theirs. */
export async function ownSavedReportRow(
  tx: Tx,
  context: ScopedTenantContext,
  ownerUserId: string,
  savedReportId: string,
  forUpdate = false,
): Promise<Row> {
  const query = tx
    .select()
    .from(savedReports)
    .where(
      and(
        eq(savedReports.tenantId, context.tenant.tenantId),
        eq(savedReports.ownerUserId, ownerUserId),
        eq(savedReports.id, savedReportId),
      ),
    );
  const [row] = await (forUpdate ? query.for("update") : query);
  if (row === undefined) throw reportHttpError("SAVED_REPORT_NOT_FOUND");
  return row;
}

/** The owner's saved query, parsed (404 when it is not theirs). */
export function ownSavedReportQuery(
  context: ScopedTenantContext,
  ownerUserId: string,
  savedReportId: string,
): Promise<ReportBuilderQuery> {
  return withTenant(db, context, async (tx) =>
    reportBuilderQuerySchema.parse(
      (await ownSavedReportRow(tx, context, ownerUserId, savedReportId)).query,
    ),
  );
}

export async function createSavedReport(
  context: ScopedTenantContext,
  ownerUserId: string,
  input: CreateSavedReportInput,
): Promise<SavedReport> {
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .insert(savedReports)
      .values({
        tenantId: context.tenant.tenantId,
        ownerUserId,
        name: input.name,
        description: input.description ?? null,
        query: input.query,
      })
      .returning(),
  );
  if (row === undefined) throw new Error("Saved report insert returned no row");
  return toSavedReport(row);
}

export async function updateSavedReport(
  context: ScopedTenantContext,
  ownerUserId: string,
  savedReportId: string,
  patch: UpdateSavedReportInput,
): Promise<SavedReport> {
  return withTenant(db, context, async (tx) => {
    await ownSavedReportRow(tx, context, ownerUserId, savedReportId, true);
    const [row] = await tx
      .update(savedReports)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...(patch.query === undefined ? {} : { query: patch.query }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        updatedAt: sql`greatest(now(), ${savedReports.createdAt})`,
      })
      .where(
        and(
          eq(savedReports.tenantId, context.tenant.tenantId),
          eq(savedReports.id, savedReportId),
        ),
      )
      .returning();
    if (row === undefined) throw reportHttpError("SAVED_REPORT_NOT_FOUND");
    return toSavedReport(row);
  });
}

function pageAfter(
  cursor: string | undefined,
): { createdAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
  }
  const [createdAt, id] = keys;
  if (typeof createdAt !== "string" || typeof id !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
  return { createdAt, id };
}

/** Newest first; the owner's rows only. */
export async function listSavedReports(
  context: ScopedTenantContext,
  ownerUserId: string,
  query: CursorPageQuery,
): Promise<SavedReportPage> {
  const after = pageAfter(query.cursor);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        ...getTableColumns(savedReports),
        // Microsecond cursor: a millisecond ISO string would skip or repeat
        // rows created within the same millisecond.
        cursorAt: sql<string>`${savedReports.createdAt}::text`,
      })
      .from(savedReports)
      .where(
        and(
          eq(savedReports.tenantId, context.tenant.tenantId),
          eq(savedReports.ownerUserId, ownerUserId),
          after === undefined
            ? sql`TRUE`
            : sql`(${savedReports.createdAt}, ${savedReports.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(savedReports.createdAt), desc(savedReports.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return savedReportPageSchema.parse({
    data: page.map(toSavedReport),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCursor([last.cursorAt, last.id])
          : null,
    },
  });
}
