// Dynamic customer segments (legend-ts50, docs/briefs/290d, PRD §3.21
// "Segmentasi"). Staff with `crm.segment.manage` preview a definition, save it
// and list the saved segments. Saving materializes the segment at once and the
// daily worker job (worker/segment-materialize.job.ts) refreshes it; preview
// runs the same matcher, so a preview and a fresh materialization agree.
//
// Matching reuses `matchesSegment` from the shared contract on facts derived
// per profile (days since last visit, visited outlets, ordered items, birth
// month). Closed and merged-away profiles are never segment members. `tierId`
// stays null on the profile DTO until 290e, so a `tier` rule matches nobody yet.
// Every function runs in `withTenant`, so RLS scopes rows to the tenant.

import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  matchesSegment,
  segmentDefinitionSchema,
  type CustomerProfileDto,
  type Segment,
  type SegmentDefinition,
  type SegmentPreview,
} from "@starter/shared/crm";
import { db } from "../db";
import { customerProfiles } from "../db/schema/crm-member";
import { customerVisits } from "../db/schema/crm-ledger";
import { segmentMembers, segments } from "../db/schema/crm-segments";
import type * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { toCustomerProfileDto } from "./member-profile.service";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type SegmentRow = typeof segments.$inferSelect;

const SAMPLE_SIZE = 20;
const SCAN_CHUNK = 500;
const INSERT_CHUNK = 1000;
const DAY_MS = 86_400_000;

/**
 * Audit field names kept unmasked: a count only. The segment name is left out
 * because the audit schema treats any `name` key as sensitive.
 */
const AUDIT_SAFE_FIELDS = ["size"] as const;

export type MatchResult = { size: number; ids: string[]; sample: string[] };

function stripHash(
  row: Parameters<typeof toCustomerProfileDto>[0],
): CustomerProfileDto {
  const { whatsappHash, ...dto } = toCustomerProfileDto(row);
  void whatsappHash; // never leaves the server
  return dto;
}

function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    definition: row.definition,
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    size: row.size,
  };
}

const needs = (definition: SegmentDefinition, kind: string) =>
  definition.rules.some((rule) => rule.kind === kind);

/**
 * Every live profile of the tenant that matches `definition`, scanned in id
 * order in bounded chunks. `ids` is the full match set (ordered by id) and
 * `rows` keeps the first `SAMPLE_SIZE` matched rows for the preview.
 */
async function matchProfiles(
  tx: Tx,
  tenantId: string,
  definition: SegmentDefinition,
  now: Date,
) {
  const wantOutlets = needs(definition, "outlet");
  const wantItems = needs(definition, "favorite_item");
  const ids: string[] = [];
  const rows: (typeof customerProfiles.$inferSelect)[] = [];
  let after: string | null = null;
  for (;;) {
    const chunk: (typeof customerProfiles.$inferSelect)[] = await tx
      .select()
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId as TenantId),
          ne(customerProfiles.membershipStatus, "closed"),
          isNull(customerProfiles.mergedIntoProfileId),
          after === null ? undefined : gt(customerProfiles.id, after),
        ),
      )
      .orderBy(asc(customerProfiles.id))
      .limit(SCAN_CHUNK);
    if (chunk.length === 0) break;
    after = chunk[chunk.length - 1]!.id;
    const chunkIds = chunk.map((row) => row.id);

    const outletsByProfile = new Map<string, string[]>();
    if (wantOutlets) {
      const visited = await tx
        .selectDistinct({
          profileId: customerVisits.customerProfileId,
          outletId: customerVisits.outletId,
        })
        .from(customerVisits)
        .where(
          and(
            eq(customerVisits.tenantId, tenantId as TenantId),
            inArray(customerVisits.customerProfileId, chunkIds),
          ),
        );
      for (const v of visited)
        outletsByProfile.set(v.profileId, [
          ...(outletsByProfile.get(v.profileId) ?? []),
          v.outletId,
        ]);
    }

    // Items the member ordered on paid (completed) orders, voided lines apart.
    const itemsByProfile = new Map<string, string[]>();
    if (wantItems) {
      const ordered = await tx.execute(sql`
        SELECT DISTINCT o.customer_profile_id::text AS profile_id,
                        oi.menu_item_id::text AS menu_item_id
          FROM orders o
          JOIN order_items oi
            ON oi.tenant_id = o.tenant_id AND oi.order_id = o.id
         WHERE o.tenant_id = ${tenantId}::uuid
           AND o.status = 'completed'
           AND oi.status <> 'voided'
           AND o.customer_profile_id IN (${sql.join(
             chunkIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
      `);
      for (const r of ordered.rows) {
        const key = String(r.profile_id);
        itemsByProfile.set(key, [
          ...(itemsByProfile.get(key) ?? []),
          String(r.menu_item_id),
        ]);
      }
    }

    for (const row of chunk) {
      const profile = toCustomerProfileDto(row);
      const last = row.lastVisitAt;
      const month = row.birthMonthDay
        ? Number(row.birthMonthDay.slice(0, 2))
        : null;
      const matched = matchesSegment(
        {
          profile,
          daysSinceLastVisit: last
            ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / DAY_MS))
            : null,
          favoriteMenuItemIds: itemsByProfile.get(row.id) ?? [],
          visitedOutletIds: (outletsByProfile.get(row.id) ?? []) as never,
          birthMonth: month,
        },
        definition,
      );
      if (!matched) continue;
      ids.push(row.id);
      if (rows.length < SAMPLE_SIZE) rows.push(row);
    }
    if (chunk.length < SCAN_CHUNK) break;
  }
  return { ids, rows };
}

export async function previewSegment(
  context: ScopedTenantContext,
  definition: SegmentDefinition,
): Promise<SegmentPreview> {
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const { ids, rows } = await matchProfiles(
      tx,
      context.tenant.tenantId,
      definition,
      now,
    );
    return { size: ids.length, sample: rows.map(stripHash) };
  });
}

/**
 * Replaces the materialized members of `segmentId` with the current matches and
 * stamps `refreshedAt` and `size`. The segment row is locked first, so two
 * refreshes of one segment run one after the other.
 */
export async function refreshSegmentMembers(
  tx: Tx,
  tenantId: string,
  segmentId: string,
  now: Date,
): Promise<SegmentRow | null> {
  const [locked] = await tx
    .select()
    .from(segments)
    .where(
      and(
        eq(segments.tenantId, tenantId as TenantId),
        eq(segments.id, segmentId),
      ),
    )
    .for("update");
  if (!locked) return null;
  const parsed = segmentDefinitionSchema.safeParse(locked.definition);
  if (!parsed.success) return null;
  const { ids } = await matchProfiles(tx, tenantId, parsed.data, now);
  await tx
    .delete(segmentMembers)
    .where(
      and(
        eq(segmentMembers.tenantId, tenantId as TenantId),
        eq(segmentMembers.segmentId, segmentId),
      ),
    );
  for (let i = 0; i < ids.length; i += INSERT_CHUNK)
    await tx.insert(segmentMembers).values(
      ids.slice(i, i + INSERT_CHUNK).map((customerProfileId) => ({
        tenantId: tenantId as TenantId,
        segmentId,
        customerProfileId,
        materializedAt: now,
      })),
    );
  const [updated] = await tx
    .update(segments)
    .set({ refreshedAt: now, size: ids.length, updatedAt: now })
    .where(
      and(
        eq(segments.tenantId, tenantId as TenantId),
        eq(segments.id, segmentId),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Saves a segment and materializes it in the same transaction. */
export async function createSegment(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { name: string; definition: SegmentDefinition },
): Promise<Segment> {
  const tenantId = context.tenant.tenantId;
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(segments)
      .values({
        tenantId,
        name: input.name,
        definition: input.definition,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Segment insert returned no row");
    const refreshed = await refreshSegmentMembers(tx, tenantId, row.id, now);
    if (!refreshed) throw new Error("Segment vanished during materialization");
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "segment.created",
        objectType: "segment",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: { size: refreshed.size },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      AUDIT_SAFE_FIELDS,
    );
    return toSegment(refreshed);
  });
}

type Cursor = { ts: string; id: string };
// A cursor keeps the database's own `created_at::text` (microseconds), as the
// loyalty anomaly list does, so rows sharing one `now()` are not skipped.
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_TS =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(`${cursor.ts}|${cursor.id}`).toString("base64url");

function decodeCursor(value: string): Cursor {
  const parts = Buffer.from(value, "base64url").toString().split("|");
  const [ts, id] = parts;
  if (
    parts.length !== 2 ||
    !ts ||
    !id ||
    !CURSOR_TS.test(ts) ||
    !ROW_ID.test(id)
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return { ts, id };
}

/** Newest first, keyset on `(created_at, id)`. */
export async function listSegments(
  context: ScopedTenantContext,
  query: { cursor?: string; limit: number },
): Promise<Page<Segment>> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  return withTenant(db, context, async (tx) => {
    const found = await tx
      .select({ row: segments, ts: sql<string>`${segments.createdAt}::text` })
      .from(segments)
      .where(
        and(
          eq(segments.tenantId, context.tenant.tenantId),
          cursor
            ? sql`(${segments.createdAt}, ${segments.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(segments.createdAt), desc(segments.id))
      .limit(query.limit + 1);
    const slice = found.slice(0, query.limit);
    const last = slice.at(-1);
    return {
      data: slice.map((entry) => toSegment(entry.row)),
      meta: {
        limit: query.limit,
        nextCursor:
          found.length > query.limit && last
            ? encodeCursor({ ts: last.ts, id: last.row.id })
            : null,
      },
    };
  });
}
