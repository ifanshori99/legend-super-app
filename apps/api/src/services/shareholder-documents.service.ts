// Shareholder documents (PRD v1.7 §3.35 Dokumen, §6 I `shareholder_documents`,
// SH-01; bead legend-69yq). Management uploads a PDF, attaches it to a draft
// document and publishes it once; a shareholder then sees only published
// `shareholders` documents of the profit entities they belong to.
//
// - Upload: PDF only (magic bytes), <= 10 MiB, stored under a server-chosen key
//   (never the user's filename), private, tenant-wide (`outletId: null`).
// - Publish is one-way and idempotent; migration trigger makes a published row
//   immutable.
// - The shareholder -> profit entity link is an injected port. Production
//   default is fail-closed until legend-2ljb wires the real resolver.
// - A document a shareholder may not see is NOT_FOUND, never PERMISSION_DENIED,
//   so its existence does not leak. File keys and signed URLs are never logged.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  assertDocumentVisibleToShareholders,
  createShareholderDocumentInputSchema,
  listShareholderDocuments,
  publishShareholderDocument,
  shareholderDocumentFileSchema,
  shareholderDocumentSchema,
  uploadShareholderDocumentFileMetadataSchema,
  type ShareholderDocument,
  type ShareholderDocumentFile,
} from "@starter/shared/accounting";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  profitEntities,
  shareholderDocumentFiles,
  shareholderDocuments,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  auditAccountingChange,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";
import {
  assertScannerAcceptsDocuments,
  type MalwareScanner,
} from "./core-image";
import { assertSafePdf } from "./pdf-safety";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const profitEntityNotFound = () =>
  new HttpError(
    422,
    "PROFIT_ENTITY_NOT_FOUND",
    "The profit entity does not exist.",
  );

/** 23503 on a profit entity FK (0217): a race past the existence check. */
function profitEntityFkViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "23503" &&
      typeof candidate.constraint === "string" &&
      candidate.constraint.endsWith("_profit_entity_fk")) ||
    profitEntityFkViolation(candidate.cause, depth + 1)
  );
}

async function assertProfitEntityExists(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
): Promise<void> {
  const [found] = await tx
    .select({ id: profitEntities.id })
    .from(profitEntities)
    .where(
      and(
        eq(profitEntities.tenantId, tenantId),
        eq(profitEntities.id, profitEntityId),
      ),
    )
    .limit(1);
  if (!found) throw profitEntityNotFound();
}
const SIGNED_URL_SECONDS = 300;

/** Which profit entities a user holds shares in (legend-2ljb owns the data). */
export type ShareholderMembership = {
  profitEntityIdsForUser(
    tx: TenantTransaction,
    context: ScopedTenantContext,
    userId: string,
  ): Promise<string[]>;
};

/** Production default: a shareholder sees nothing until the real resolver ships. */
export const failClosedShareholderMembership: ShareholderMembership = {
  profitEntityIdsForUser: async () => [],
};

export type ShareholderDocumentViewer =
  { kind: "manager" } | { kind: "shareholder"; userId: string };

type DocumentRow = typeof shareholderDocuments.$inferSelect;
type ListQuery = ReturnType<typeof listShareholderDocuments.query.parse>;

const iso = (value: Date | string) => new Date(value).toISOString();

function toDocument(row: DocumentRow): ShareholderDocument {
  return shareholderDocumentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    profitEntityId: row.profitEntityId,
    kind: row.kind,
    title: row.title,
    fileKey: row.fileKey,
    visibility: row.visibility,
    publishedAt: row.publishedAt === null ? null : iso(row.publishedAt),
    publishedBy: row.publishedBy,
    createdAt: iso(row.createdAt),
  });
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Document not found.");
}

/** SQL twin of `assertDocumentVisibleToShareholders` + membership. */
async function shareholderFilter(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  userId: string,
  membership: ShareholderMembership,
): Promise<SQL | null> {
  const entityIds = await membership.profitEntityIdsForUser(
    tx,
    context,
    userId,
  );
  if (entityIds.length === 0) return null;
  return and(
    inArray(shareholderDocuments.profitEntityId, entityIds),
    eq(shareholderDocuments.visibility, "shareholders"),
    sql`${shareholderDocuments.publishedAt} IS NOT NULL`,
  ) as SQL;
}

// ----------------------------------------------------------------- upload

export async function uploadShareholderDocumentFileService(
  context: ScopedTenantContext,
  actorId: UserId,
  input: unknown,
  bytes: Uint8Array,
  deps: { storage: ObjectStorage; scanner: MalwareScanner },
): Promise<ShareholderDocumentFile> {
  assertTrustedScopedContext(context);
  const { profitEntityId } =
    uploadShareholderDocumentFileMetadataSchema.parse(input);
  if (bytes.byteLength === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "The file is empty.");
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The file is too large.");
  if (Buffer.from(bytes).subarray(0, 5).toString("ascii") !== "%PDF-")
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Only PDF files are accepted.",
    );
  // Before any blob is stored: an unknown (or foreign tenant) entity is 422.
  await withTenant(db, context, (tx) =>
    assertProfitEntityExists(tx, context.tenant.tenantId, profitEntityId),
  );
  // A scanner that cannot vet documents (production noop) refuses before any
  // blob is stored (legend-0w2wy).
  assertScannerAcceptsDocuments(deps.scanner);
  // Structural check (malformed, encrypted, active content) before the scan
  // and before any blob is stored (legend-851ef).
  await assertSafePdf(bytes, { maxBytes: MAX_PDF_BYTES });
  // Rejects on detection or scanner failure: nothing is stored either way.
  await deps.scanner.scan(bytes);
  const id = randomUUID();
  const fileKey = `shareholder-documents/${id}.pdf`;
  const lookup = {
    tenantId: context.tenant.tenantId,
    outletId: null,
    reference: id,
    key: fileKey,
  };
  await deps.storage.put(context, {
    ...lookup,
    contentType: "application/pdf",
    content: new Uint8Array(bytes),
    visibility: "private",
  });
  try {
    await withTenant(db, context, (tx) =>
      tx.insert(shareholderDocumentFiles).values({
        tenantId: context.tenant.tenantId,
        id,
        profitEntityId,
        fileKey,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        uploadedBy: actorId,
      }),
    );
  } catch (error) {
    await Promise.allSettled([deps.storage.delete(context, lookup)]);
    if (profitEntityFkViolation(error)) throw profitEntityNotFound();
    throw error;
  }
  return shareholderDocumentFileSchema.parse({
    fileKey,
    contentType: "application/pdf",
    sizeBytes: bytes.byteLength,
  });
}

// ----------------------------------------------------------------- create

export async function createShareholderDocumentService(
  context: ScopedTenantContext,
  actorId: UserId,
  input: unknown,
): Promise<ShareholderDocument> {
  assertTrustedScopedContext(context);
  const body = createShareholderDocumentInputSchema.parse(input);
  const unusable = () =>
    new HttpError(
      422,
      "VALIDATION_ERROR",
      "Upload a PDF for this profit entity first, and use it once.",
    );
  try {
    return await withTenant(db, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      await assertProfitEntityExists(tx, tenantId, body.profitEntityId);
      const [file] = await tx
        .select({ id: shareholderDocumentFiles.id })
        .from(shareholderDocumentFiles)
        .where(
          and(
            eq(shareholderDocumentFiles.tenantId, tenantId),
            eq(shareholderDocumentFiles.fileKey, body.fileKey),
            eq(shareholderDocumentFiles.profitEntityId, body.profitEntityId),
          ),
        )
        .limit(1);
      if (!file) throw unusable();
      const [used] = await tx
        .select({ id: shareholderDocuments.id })
        .from(shareholderDocuments)
        .where(
          and(
            eq(shareholderDocuments.tenantId, tenantId),
            eq(shareholderDocuments.fileKey, body.fileKey),
          ),
        )
        .limit(1);
      if (used) throw unusable();
      const [row] = await tx
        .insert(shareholderDocuments)
        .values({
          tenantId,
          id: randomUUID(),
          profitEntityId: body.profitEntityId,
          kind: body.kind,
          title: body.title,
          fileKey: body.fileKey,
          visibility: body.visibility,
          publishedAt: null,
          publishedBy: null,
          createdBy: actorId,
        })
        .returning();
      if (!row) throw new Error("Shareholder document insert returned no row");
      await auditAccountingChange(tx, context, {
        actorId,
        action: "shareholder_document.created",
        objectType: "shareholder_document",
        objectId: row.id,
        before: null,
        after: { kind: row.kind, visibility: row.visibility },
      });
      return toDocument(row);
    });
  } catch (error) {
    // Two concurrent creates for one file: the unique key picks one.
    if (uniqueViolation(error)) throw unusable();
    if (profitEntityFkViolation(error)) throw profitEntityNotFound();
    throw error;
  }
}

// ---------------------------------------------------------------- publish

export async function publishShareholderDocumentService(
  context: ScopedTenantContext,
  actorId: UserId,
  id: string,
  body: unknown,
): Promise<ShareholderDocument> {
  assertTrustedScopedContext(context);
  // The key makes a retry safe; publishing is idempotent by state anyway.
  publishShareholderDocument.body.parse(body);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(shareholderDocuments)
      .where(
        and(
          eq(shareholderDocuments.tenantId, context.tenant.tenantId),
          eq(shareholderDocuments.id, id),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw notFound();
    if (row.publishedAt !== null) return toDocument(row);
    const [published] = await tx
      .update(shareholderDocuments)
      .set({ publishedAt: new Date(), publishedBy: actorId })
      .where(
        and(
          eq(shareholderDocuments.tenantId, context.tenant.tenantId),
          eq(shareholderDocuments.id, id),
        ),
      )
      .returning();
    if (!published)
      throw new Error("Shareholder document publish returned no row");
    await auditAccountingChange(tx, context, {
      actorId,
      action: "shareholder_document.published",
      objectType: "shareholder_document",
      objectId: published.id,
      before: null,
      after: { visibility: published.visibility },
    });
    return toDocument(published);
  });
}

// ------------------------------------------------------------------- list

/** created_at keeps microseconds; a JS Date does not, so the cursor carries text. */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cursorKeys(cursor: string): [string, string] {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [at, id] = keys;
  if (
    keys.length !== 2 ||
    typeof at !== "string" ||
    typeof id !== "string" ||
    !CURSOR_INSTANT.test(at) ||
    !CURSOR_UUID.test(id)
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return [at, id];
}

export async function listShareholderDocumentsService(
  context: ScopedTenantContext,
  viewer: ShareholderDocumentViewer,
  query: ListQuery,
  deps: { membership: ShareholderMembership },
): Promise<CursorPage<ShareholderDocument>> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(shareholderDocuments.tenantId, context.tenant.tenantId),
    ];
    if (viewer.kind === "shareholder") {
      const own = await shareholderFilter(
        tx,
        context,
        viewer.userId,
        deps.membership,
      );
      if (!own)
        return { data: [], meta: { limit: query.limit, nextCursor: null } };
      filters.push(own);
    }
    if (query.profitEntityId)
      filters.push(
        eq(shareholderDocuments.profitEntityId, query.profitEntityId),
      );
    if (query.kind) filters.push(eq(shareholderDocuments.kind, query.kind));
    if (query.cursor) {
      const [at, id] = cursorKeys(query.cursor);
      const keyset = or(
        sql`${shareholderDocuments.createdAt} < ${at}::timestamptz`,
        and(
          sql`${shareholderDocuments.createdAt} = ${at}::timestamptz`,
          lt(shareholderDocuments.id, id),
        ),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select({
        row: shareholderDocuments,
        key: sql<string>`to_char(${shareholderDocuments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(shareholderDocuments)
      .where(and(...filters))
      .orderBy(
        desc(shareholderDocuments.createdAt),
        desc(shareholderDocuments.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const data = page.map(({ row }) => {
      const doc = toDocument(row);
      // Defense in depth: the SQL filter already guarantees this.
      if (viewer.kind === "shareholder")
        assertDocumentVisibleToShareholders(doc);
      return doc;
    });
    const last = page.at(-1);
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.key, last.row.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------- signed URL

export async function shareholderDocumentSignedUrlService(
  context: ScopedTenantContext,
  viewer: ShareholderDocumentViewer,
  id: string,
  deps: { storage: ObjectStorage; membership: ShareholderMembership },
): Promise<{ url: string; expiresAt: string }> {
  assertTrustedScopedContext(context);
  const row = await withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(shareholderDocuments.tenantId, context.tenant.tenantId),
      eq(shareholderDocuments.id, id),
    ];
    if (viewer.kind === "shareholder") {
      const own = await shareholderFilter(
        tx,
        context,
        viewer.userId,
        deps.membership,
      );
      if (!own) return undefined;
      filters.push(own);
    }
    const [found] = await tx
      .select()
      .from(shareholderDocuments)
      .where(and(...filters))
      .limit(1);
    return found;
  });
  if (!row) throw notFound();
  if (viewer.kind === "shareholder")
    assertDocumentVisibleToShareholders(toDocument(row));
  const url = await deps.storage.signedGetUrl(context, {
    tenantId: context.tenant.tenantId,
    outletId: null,
    reference: row.id,
    key: row.fileKey,
    visibility: "private",
    expiresInSeconds: SIGNED_URL_SECONDS,
  });
  return {
    url,
    expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString(),
  };
}
