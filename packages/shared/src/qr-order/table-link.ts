// Service-only table link ("link meja", PRD v1.7 §3 "Operasi Meja"): two or
// more tables with an active session are grouped for service. Unlike gabung
// meja (table-operations.ts mergeTableSessions) the bills stay separate and
// are paid separately; sessions are untouched.
//
// Decisions (CTO defaults, legend-1nmh):
// - A group member is (table, its active session); every table to link must
//   have an active session (pending_confirmation, open or bill_requested).
// - A table is in at most one live group.
// - A member leaves when its own session closes. With fewer than 2 live
//   members the group dissolves and the remaining member gets
//   `group_dissolved`.
// - The board shows a group only while it has 2+ live members.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  CoreError,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  tableIdSchema,
  tableLinkGroupIdSchema,
  tableSessionIdSchema,
} from "./schemas.ts";

const note = z.string().max(200);

export const TABLE_LINK_LEFT_REASONS = [
  "staff",
  "session_closed",
  "group_dissolved",
  "session_merged",
] as const;
export const tableLinkLeftReasonSchema = z.enum(TABLE_LINK_LEFT_REASONS);
export type TableLinkLeftReason = z.infer<typeof tableLinkLeftReasonSchema>;

export const tableLinkGroupSchema = z.strictObject({
  id: tableLinkGroupIdSchema,
  outletId: outletIdSchema,
  members: z
    .array(
      z.strictObject({
        tableId: tableIdSchema,
        sessionId: tableSessionIdSchema,
      }),
    )
    .min(2),
  createdAt: isoDateTimeSchema,
});
export type TableLinkGroup = z.infer<typeof tableLinkGroupSchema>;

/** With `groupId` the tables join that group; without it a new group forms. */
export const linkTablesInputSchema = clientInputSchema({
  tableIds: z.array(tableIdSchema).min(1).max(12),
  groupId: tableLinkGroupIdSchema.optional(),
  note: note.optional(),
});
export type LinkTablesInput = z.infer<typeof linkTablesInputSchema>;

export const linkTablesResultSchema = z.strictObject({
  group: tableLinkGroupSchema,
});
export type LinkTablesResult = z.infer<typeof linkTablesResultSchema>;

/** `tableIds` omitted dissolves the whole group. */
export const unlinkTablesInputSchema = clientInputSchema({
  tableIds: z.array(tableIdSchema).min(1).max(12).optional(),
  note: note.optional(),
});
export type UnlinkTablesInput = z.infer<typeof unlinkTablesInputSchema>;

/** `group` is null when the unlink dissolved the group. */
export const unlinkTablesResultSchema = z.strictObject({
  group: tableLinkGroupSchema.nullable(),
  unlinkedTableIds: z.array(tableIdSchema),
});
export type UnlinkTablesResult = z.infer<typeof unlinkTablesResultSchema>;

/**
 * Shape check before any lookup: no duplicate table ids, and a new group
 * (no groupId) needs at least two distinct tables.
 */
export function assertLinkRequestShape(input: {
  groupId?: string | null;
  tableIds: readonly string[];
}): void {
  const distinct = new Set(input.tableIds);
  if (distinct.size !== input.tableIds.length)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Meja yang di-link tidak boleh ganda.",
    );
  if (!input.groupId && distinct.size < 2)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Link meja butuh minimal dua meja berbeda.",
    );
}

const groupParams = z.strictObject({ groupId: tableLinkGroupIdSchema });

/** Link tables for service: separate bills, one group on the board. */
export const linkTables = defineEndpoint({
  method: "POST",
  path: "/api/table-links",
  body: linkTablesInputSchema,
  response: dataResponseSchema(linkTablesResultSchema),
});

/** Remove tables from a group, or dissolve it when no tables are given. */
export const unlinkTables = defineEndpoint({
  method: "POST",
  path: "/api/table-links/:groupId/unlink",
  params: groupParams,
  body: unlinkTablesInputSchema,
  response: dataResponseSchema(unlinkTablesResultSchema),
});
