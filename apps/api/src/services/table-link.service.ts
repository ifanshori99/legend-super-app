// Table link groups (PRD v1.7 §3 "9. Denah & Meja": "Gabung meja (merge/link)";
// legend-1nmh). A link groups two or more tables that are served together; it
// is for service only. Every session keeps its own bill, paid on its own, and
// no order, payment or session row is touched here.
//
// Rules (CTO defaults):
// - A member is a table with its active session. Linking needs an active
//   session on every table, and a table is in at most one live group.
// - A member leaves with its own session: closing, expiring or merging the
//   session releases it, and the table frees itself as it always did.
// - A group with fewer than two live members is no group: it dissolves, so the
//   board never shows a link of one, and "the last session closed" ends it too.
// - A repeat of a request that already holds answers 200 and writes nothing.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  assertLinkRequestShape,
  tableLinkGroupSchema,
  type TableLinkLeftReason,
} from "@starter/shared/qr-order";
import { db } from "../db";
import { tableSessions, tables } from "../db/schema";
import { tableLinkGroups, tableLinkMembers } from "../db/schema/table-links";
import { withTenant } from "../db/tenant";
import { assertPosWriteNotOnEdge } from "./pos-edge-outlet";
import {
  activeSessionForTable,
  appendSessionEvent,
  audit,
  lockTableLiveState,
  type Tx,
} from "./table-session.service";

type GroupRow = typeof tableLinkGroups.$inferSelect;
type MemberRow = typeof tableLinkMembers.$inferSelect;
type Actor = EventEnvelope["actor"];

export type TableLinkGroupDto = ReturnType<typeof tableLinkGroupSchema.parse>;

export type LinkTablesResult = { group: TableLinkGroupDto };
export type UnlinkTablesResult = {
  group: TableLinkGroupDto | null;
  unlinkedTableIds: string[];
};

// ---- Reads ----------------------------------------------------------------

async function liveMembers(
  tx: Tx,
  tenantId: TenantId,
  groupId: string,
): Promise<MemberRow[]> {
  return tx
    .select()
    .from(tableLinkMembers)
    .where(
      and(
        eq(tableLinkMembers.tenantId, tenantId),
        eq(tableLinkMembers.groupId, groupId),
        isNull(tableLinkMembers.leftAt),
      ),
    );
}

async function groupDto(
  tx: Tx,
  tenantId: TenantId,
  group: GroupRow,
): Promise<TableLinkGroupDto | null> {
  if (group.dissolvedAt !== null) return null;
  const members = await liveMembers(tx, tenantId, group.id);
  if (members.length < 2) return null;
  return tableLinkGroupSchema.parse({
    id: group.id,
    outletId: group.outletId,
    members: members
      .sort((a, b) => a.tableId.localeCompare(b.tableId))
      .map((member) => ({
        tableId: member.tableId,
        sessionId: member.tableSessionId,
      })),
    createdAt: group.createdAt.toISOString(),
  });
}

/**
 * Link groups of the given tables for the floor board. Only a group with two
 * or more live members is shown; the map is keyed by table id.
 */
export async function linkGroupsForTables(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
): Promise<Map<string, { id: string; tableIds: string[] }>> {
  const members = await tx
    .select({
      groupId: tableLinkMembers.groupId,
      tableId: tableLinkMembers.tableId,
    })
    .from(tableLinkMembers)
    .where(
      and(
        eq(tableLinkMembers.tenantId, tenantId),
        eq(tableLinkMembers.outletId, outletIdSchema.parse(outletId)),
        isNull(tableLinkMembers.leftAt),
      ),
    );
  const byGroup = new Map<string, string[]>();
  for (const member of members)
    byGroup.set(member.groupId, [
      ...(byGroup.get(member.groupId) ?? []),
      member.tableId,
    ]);
  const result = new Map<string, { id: string; tableIds: string[] }>();
  for (const [id, tableIds] of byGroup) {
    if (tableIds.length < 2) continue;
    const sorted = [...tableIds].sort();
    for (const tableId of sorted) result.set(tableId, { id, tableIds: sorted });
  }
  return result;
}

// ---- Writes shared by link, unlink and the session hooks -----------------

async function releaseMembers(
  tx: Tx,
  context: ScopedTenantContext,
  group: GroupRow,
  members: readonly MemberRow[],
  reason: TableLinkLeftReason,
  actor: Actor,
  now: Date,
): Promise<void> {
  if (members.length === 0) return;
  await tx
    .update(tableLinkMembers)
    .set({ leftAt: now, leftReason: reason })
    .where(
      and(
        eq(tableLinkMembers.tenantId, context.tenant.tenantId),
        inArray(
          tableLinkMembers.id,
          members.map((member) => member.id),
        ),
      ),
    );
  for (const member of members) {
    await appendSessionEvent(tx, context, "table_session.unlinked", {
      sessionId: member.tableSessionId,
      outletId: group.outletId,
      payload: {
        groupId: group.id,
        sessionId: member.tableSessionId,
        tableId: member.tableId,
        reason,
      },
      actor,
      now,
    });
    if (actor.type === "user" && actor.id)
      await audit(
        tx,
        context,
        {
          actorUserId: actor.id,
          action: "table_session.unlinked",
          outletId: group.outletId,
          objectId: member.tableSessionId,
          before: { id: member.tableSessionId, groupId: group.id },
          after: { id: member.tableSessionId, reason },
        },
        now,
      );
  }
}

/** Ends a group that has fewer than two live members left. */
async function dissolveIfTooSmall(
  tx: Tx,
  context: ScopedTenantContext,
  group: GroupRow,
  actor: Actor,
  now: Date,
  emptiedBy: TableLinkLeftReason,
): Promise<void> {
  const remaining = await liveMembers(tx, context.tenant.tenantId, group.id);
  if (remaining.length >= 2) return;
  await releaseMembers(
    tx,
    context,
    group,
    remaining,
    "group_dissolved",
    actor,
    now,
  );
  await tx
    .update(tableLinkGroups)
    .set({
      dissolvedAt: now,
      dissolvedReason: remaining.length === 0 ? emptiedBy : "group_dissolved",
    })
    .where(
      and(
        eq(tableLinkGroups.tenantId, context.tenant.tenantId),
        eq(tableLinkGroups.id, group.id),
      ),
    );
}

async function lockGroup(
  tx: Tx,
  tenantId: TenantId,
  groupId: string,
): Promise<GroupRow | undefined> {
  const [group] = await tx
    .select()
    .from(tableLinkGroups)
    .where(
      and(
        eq(tableLinkGroups.tenantId, tenantId),
        eq(tableLinkGroups.id, groupId),
      ),
    )
    .for("update");
  return group;
}

/**
 * Called inside the transaction that ends a session (staff close, expiry,
 * merge of the source): the session leaves its group, and the group dissolves
 * when fewer than two sessions remain. The caller already holds the table lock.
 */
export async function releaseLinksOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
  reason: Extract<TableLinkLeftReason, "session_closed" | "session_merged">,
  actor: Actor,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [member] = await tx
    .select()
    .from(tableLinkMembers)
    .where(
      and(
        eq(tableLinkMembers.tenantId, tenantId),
        eq(tableLinkMembers.tableSessionId, sessionId),
        isNull(tableLinkMembers.leftAt),
      ),
    );
  if (!member) return;
  const group = await lockGroup(tx, tenantId, member.groupId);
  if (!group) return;
  const [fresh] = await tx
    .select()
    .from(tableLinkMembers)
    .where(
      and(
        eq(tableLinkMembers.tenantId, tenantId),
        eq(tableLinkMembers.id, member.id),
        isNull(tableLinkMembers.leftAt),
      ),
    );
  if (!fresh) return;
  await releaseMembers(tx, context, group, [fresh], reason, actor, now);
  await dissolveIfTooSmall(tx, context, group, actor, now, reason);
}

/** A moved session keeps its link: the member follows it to the new table. */
export async function followMovedSession(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  toTableId: string,
): Promise<void> {
  await tx
    .update(tableLinkMembers)
    .set({ tableId: toTableId })
    .where(
      and(
        eq(tableLinkMembers.tenantId, tenantId),
        eq(tableLinkMembers.tableSessionId, sessionId),
        isNull(tableLinkMembers.leftAt),
      ),
    );
}

// ---- Link -----------------------------------------------------------------

export async function linkTablesOperation(
  context: ScopedTenantContext,
  input: {
    tableIds: readonly string[];
    groupId?: string | undefined;
    note?: string | undefined;
  },
  actorUserId: string,
  now = new Date(),
): Promise<LinkTablesResult> {
  assertLinkRequestShape({ tableIds: input.tableIds, groupId: input.groupId });
  const tenantId = context.tenant.tenantId;
  const tableIds = [...new Set(input.tableIds)].sort();
  const actor: Actor = { type: "user", id: actorUserId };
  return withTenant(db, context, async (tx) => {
    const tableRows = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.tenantId, tenantId), inArray(tables.id, tableIds)));
    if (tableRows.length !== tableIds.length)
      throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
    for (const row of tableRows)
      assertOutletInScope(context.outletScope, row.outletId);
    const outletId = tableRows[0]!.outletId;
    if (tableRows.some((row) => row.outletId !== outletId))
      throw new CoreError(
        "CONFLICT",
        "Meja dari outlet yang berbeda tidak dapat dihubungkan.",
      );
    // E3b: an outlet its edge serves links its tables on the edge.
    await assertPosWriteNotOnEdge(tx, tenantId, outletIdSchema.parse(outletId));

    let existing: GroupRow | undefined;
    if (input.groupId) {
      const [found] = await tx
        .select()
        .from(tableLinkGroups)
        .where(
          and(
            eq(tableLinkGroups.tenantId, tenantId),
            eq(tableLinkGroups.id, input.groupId),
          ),
        );
      if (!found)
        throw new CoreError("NOT_FOUND", "Grup meja tidak ditemukan.");
      assertOutletInScope(context.outletScope, found.outletId);
      if (found.outletId !== outletId)
        throw new CoreError(
          "CONFLICT",
          "Grup dan meja berada di outlet yang berbeda.",
        );
      existing = found;
      const current = await liveMembers(tx, tenantId, found.id);
      for (const member of current) tableIds.push(member.tableId);
    }
    for (const id of [...new Set(tableIds)].sort())
      await lockTableLiveState(tx, tenantId, id);
    if (existing) {
      existing = await lockGroup(tx, tenantId, existing.id);
      if (!existing || existing.dissolvedAt !== null)
        throw new CoreError("CONFLICT", "Grup meja sudah dibubarkan.");
    }

    const requested = [...new Set(input.tableIds)];
    const memberships = await tx
      .select()
      .from(tableLinkMembers)
      .where(
        and(
          eq(tableLinkMembers.tenantId, tenantId),
          inArray(tableLinkMembers.tableId, requested),
          isNull(tableLinkMembers.leftAt),
        ),
      );
    const foreign = memberships.filter(
      (member) => !existing || member.groupId !== existing.id,
    );
    // Repeat of a link that already holds: every requested table sits in one
    // and the same group, and (without a groupId) nothing else does.
    if (
      memberships.length === requested.length &&
      foreign.length === 0 &&
      existing
    ) {
      return { group: (await groupDto(tx, tenantId, existing))! };
    }
    if (!input.groupId && memberships.length === requested.length) {
      const groupIds = new Set(memberships.map((member) => member.groupId));
      if (groupIds.size === 1) {
        const [only] = [...groupIds];
        const members = await liveMembers(tx, tenantId, only!);
        if (members.length === requested.length) {
          const [group] = await tx
            .select()
            .from(tableLinkGroups)
            .where(
              and(
                eq(tableLinkGroups.tenantId, tenantId),
                eq(tableLinkGroups.id, only!),
              ),
            );
          const dto = group ? await groupDto(tx, tenantId, group) : null;
          if (dto) return { group: dto };
        }
      }
    }
    if (memberships.length > 0 && (foreign.length > 0 || !existing))
      throw new CoreError(
        "CONFLICT",
        "Salah satu meja sudah tergabung di grup lain; putus dulu sebelum menghubungkan lagi.",
      );

    // Every new member needs a session that is still running.
    const sessions = new Map<string, string>();
    const alreadyIn = new Set(memberships.map((member) => member.tableId));
    for (const id of requested) {
      if (alreadyIn.has(id)) continue;
      const session = await activeSessionForTable(tx, tenantId, id);
      if (!session)
        throw new CoreError(
          "CONFLICT",
          "Hanya meja yang punya sesi aktif yang dapat dihubungkan.",
        );
      sessions.set(id, session.id);
    }
    if (sessions.size === 0)
      throw new CoreError("CONFLICT", "Tidak ada meja baru untuk dihubungkan.");

    let group = existing;
    if (!group) {
      [group] = await tx
        .insert(tableLinkGroups)
        .values({
          tenantId,
          outletId,
          createdBy: actorUserId,
          createdAt: now,
        })
        .returning();
    }
    if (!group) throw new Error("Link group insert returned no row");
    await tx.insert(tableLinkMembers).values(
      [...sessions].map(([tableId, tableSessionId]) => ({
        tenantId,
        outletId,
        groupId: group.id,
        tableId,
        tableSessionId,
        joinedAt: now,
      })),
    );
    const allMembers = await liveMembers(tx, tenantId, group.id);
    if (allMembers.length < 2)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Hubungkan minimal dua meja yang punya sesi aktif.",
      );
    const allTableIds = allMembers.map((member) => member.tableId).sort();
    for (const [tableId, sessionId] of sessions) {
      await appendSessionEvent(tx, context, "table_session.linked", {
        sessionId,
        outletId,
        payload: {
          groupId: group.id,
          sessionId,
          tableId,
          tableIds: allTableIds,
        },
        actor,
        now,
      });
      await audit(
        tx,
        context,
        {
          actorUserId,
          action: "table_session.linked",
          outletId,
          objectId: sessionId,
          before: null,
          after: { id: sessionId, groupId: group.id, tableIds: allTableIds },
        },
        now,
      );
    }
    return { group: (await groupDto(tx, tenantId, group))! };
  });
}

// ---- Unlink ---------------------------------------------------------------

export async function unlinkTablesOperation(
  context: ScopedTenantContext,
  groupId: string,
  input: {
    tableIds?: readonly string[] | undefined;
    note?: string | undefined;
  },
  actorUserId: string,
  now = new Date(),
): Promise<UnlinkTablesResult> {
  const tenantId = context.tenant.tenantId;
  const actor: Actor = { type: "user", id: actorUserId };
  return withTenant(db, context, async (tx) => {
    const [located] = await tx
      .select()
      .from(tableLinkGroups)
      .where(
        and(
          eq(tableLinkGroups.tenantId, tenantId),
          eq(tableLinkGroups.id, groupId),
        ),
      );
    if (!located)
      throw new CoreError("NOT_FOUND", "Grup meja tidak ditemukan.");
    assertOutletInScope(context.outletScope, located.outletId);
    await assertPosWriteNotOnEdge(
      tx,
      tenantId,
      outletIdSchema.parse(located.outletId),
    );
    const before = await liveMembers(tx, tenantId, located.id);
    for (const id of [
      ...new Set(before.map((member) => member.tableId)),
    ].sort())
      await lockTableLiveState(tx, tenantId, id);
    const group = await lockGroup(tx, tenantId, located.id);
    if (!group) throw new CoreError("NOT_FOUND", "Grup meja tidak ditemukan.");
    const members = await liveMembers(tx, tenantId, group.id);
    const wanted = input.tableIds ? new Set(input.tableIds) : null;
    const leaving = members.filter(
      (member) => wanted === null || wanted.has(member.tableId),
    );
    // Repeat of an unlink that already holds: nothing of it is left to undo.
    if (leaving.length === 0)
      return {
        group: await groupDto(tx, tenantId, group),
        unlinkedTableIds: [],
      };

    await releaseMembers(tx, context, group, leaving, "staff", actor, now);
    const stillLive = await liveMembers(tx, tenantId, group.id);
    const dissolvedRest = stillLive.length < 2 ? stillLive : [];
    await dissolveIfTooSmall(tx, context, group, actor, now, "staff");
    const [after] = await tx
      .select()
      .from(tableLinkGroups)
      .where(
        and(
          eq(tableLinkGroups.tenantId, tenantId),
          eq(tableLinkGroups.id, group.id),
        ),
      );
    return {
      group: after ? await groupDto(tx, tenantId, after) : null,
      unlinkedTableIds: [...leaving, ...dissolvedRest]
        .map((member) => member.tableId)
        .sort(),
    };
  });
}

// Keeps `tableSessions` and `sql` imports honest for callers that extend this file.
void tableSessions;
void sql;
void toIsoDateTime;
