// Edge side of the edge -> cloud command path (card F1, brief 1269): the
// durable record. A command is frozen in the caller's transaction (id, exact
// body text), so the bill it locks and the command commit together. The state
// moves pending -> unknown (committed BEFORE the first send) -> final outcome.
import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  CoreError,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EDGE_COMMAND_MAX_BYTES,
  edgeCommandBodySchema,
  type EdgeCommandOutcome,
} from "@starter/shared/edge";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { edgeCommandRequests } from "../db/schema";
import { withTenant } from "../db/tenant.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import type { VerifiedEdgeNode } from "../services/staff-pin-sync.ts";

/** The local node the command belongs to (from the node's own credential). */
export type EdgeCommandNode = Pick<
  VerifiedEdgeNode,
  "tenantId" | "outletId" | "edgeNodeId"
>;
export type EdgeCommandRequest = typeof edgeCommandRequests.$inferSelect;
/** A command that still has its frozen body (every open one does). */
export type FrozenEdgeCommand = EdgeCommandRequest & { body: string };
/** Applies a settled command locally, in the transaction that settles it. */
export type EdgeCommandSettledHook = (
  tx: EdgeTx,
  row: EdgeCommandRequest,
) => Promise<void>;
export type EdgeCommandSettledHooks = Readonly<
  Record<string, EdgeCommandSettledHook>
>;
/** What a command locks while it is open, e.g. an order. */
export type EdgeCommandSubject = { readonly type: string; readonly id: string };

const OPEN_STATUSES: ("pending" | "unknown")[] = ["pending", "unknown"];

const byId = (node: EdgeCommandNode, id: string) =>
  and(
    eq(edgeCommandRequests.tenantId, node.tenantId),
    eq(edgeCommandRequests.outletId, node.outletId),
    eq(edgeCommandRequests.id, id),
  );

export async function readEdgeCommand(
  tx: EdgeTx,
  node: EdgeCommandNode,
  id: string,
): Promise<EdgeCommandRequest | null> {
  const [row] = await tx
    .select()
    .from(edgeCommandRequests)
    .where(byId(node, id));
  return row ?? null;
}

/** The open command that locks this subject, or null when it is free. */
export async function openEdgeCommandFor(
  tx: EdgeTx,
  node: EdgeCommandNode,
  subject: EdgeCommandSubject,
): Promise<EdgeCommandRequest | null> {
  const [row] = await tx
    .select()
    .from(edgeCommandRequests)
    .where(
      and(
        eq(edgeCommandRequests.tenantId, node.tenantId),
        eq(edgeCommandRequests.outletId, node.outletId),
        eq(edgeCommandRequests.subjectType, subject.type),
        eq(edgeCommandRequests.subjectId, subject.id),
        inArray(edgeCommandRequests.status, OPEN_STATUSES),
      ),
    );
  return row ?? null;
}

/**
 * Freezes a new command and locks its subject. CONFLICT while the subject has
 * an open command: a new key never replaces one whose outcome is not known.
 */
export async function freezeEdgeCommand(
  tx: EdgeTx,
  node: EdgeCommandNode,
  input: {
    kind: string;
    payload: Record<string, unknown>;
    subject: EdgeCommandSubject;
    ttlMs: number;
    now?: Date;
  },
): Promise<FrozenEdgeCommand> {
  const issuedAt = input.now ?? new Date();
  const command = edgeCommandBodySchema.parse({
    v: 1,
    id: createUlid(),
    kind: input.kind,
    payload: input.payload,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
  });
  const body = JSON.stringify(command);
  if (Buffer.byteLength(body, "utf8") > EDGE_COMMAND_MAX_BYTES)
    throw new CoreError("VALIDATION_ERROR", "Isi perintah terlalu besar.");
  const [row] = await tx
    .insert(edgeCommandRequests)
    .values({
      tenantId: node.tenantId,
      outletId: node.outletId,
      id: command.id,
      edgeNodeId: node.edgeNodeId,
      kind: command.kind,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      body,
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new CoreError(
      "CONFLICT",
      "Masih ada perintah ke cloud yang belum selesai.",
    );
  return { ...row, body };
}

/**
 * Records an attempt before anything leaves the edge. Returns the row to send,
 * or the settled row unchanged (nothing to send), or null for an unknown id.
 */
export async function markEdgeCommandAttempt(
  tx: EdgeTx,
  node: EdgeCommandNode,
  id: string,
): Promise<EdgeCommandRequest | null> {
  const [row] = await tx
    .update(edgeCommandRequests)
    .set({
      status: "unknown",
      attempts: sql`${edgeCommandRequests.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(
      and(byId(node, id), inArray(edgeCommandRequests.status, OPEN_STATUSES)),
    )
    .returning();
  return row ?? readEdgeCommand(tx, node, id);
}

/**
 * Records the cloud's outcome once; an already settled row stays as it is. The
 * hook of the kind runs in the same transaction, only when the row really moved:
 * settling frees the subject, so the local result must commit with it. A failing
 * or missing hook throws; the caller rolls back and the command stays open.
 */
export async function settleEdgeCommand(
  tx: EdgeTx,
  node: EdgeCommandNode,
  outcome: EdgeCommandOutcome,
  hooks: EdgeCommandSettledHooks,
): Promise<EdgeCommandRequest | null> {
  const [row] = await tx
    .update(edgeCommandRequests)
    .set({
      status: outcome.status,
      result: outcome.status === "succeeded" ? outcome.result : null,
      code: outcome.status === "refused" ? outcome.code : null,
      settledAt: new Date(),
    })
    .where(
      and(
        byId(node, outcome.id),
        eq(edgeCommandRequests.kind, outcome.kind),
        eq(edgeCommandRequests.bodySha256, outcome.bodySha256),
        inArray(edgeCommandRequests.status, OPEN_STATUSES),
      ),
    )
    .returning();
  if (!row) return readEdgeCommand(tx, node, outcome.id);
  const hook = Object.hasOwn(hooks, row.kind) ? hooks[row.kind] : undefined;
  if (!hook) throw new Error("Edge command kind has no settled hook");
  await hook(tx, row);
  return row;
}

/**
 * Open commands of this node in id order (recovery after a restart), after the
 * id `after` when given. Only commands last sent (or created) at or before
 * `quietSince`; a time in the future is a clock set back and counts as old.
 */
export async function listOpenEdgeCommands(
  tx: EdgeTx,
  node: EdgeCommandNode,
  input: {
    limit: number;
    quietSince: Date;
    after: string | null;
    exclude: readonly string[];
  },
): Promise<EdgeCommandRequest[]> {
  const touched = sql`coalesce(${edgeCommandRequests.lastAttemptAt}, ${edgeCommandRequests.createdAt})`;
  const now = new Date();
  return tx
    .select()
    .from(edgeCommandRequests)
    .where(
      and(
        eq(edgeCommandRequests.tenantId, node.tenantId),
        eq(edgeCommandRequests.outletId, node.outletId),
        eq(edgeCommandRequests.edgeNodeId, node.edgeNodeId),
        inArray(edgeCommandRequests.status, OPEN_STATUSES),
        or(
          sql`${touched} <= ${input.quietSince.toISOString()}::timestamptz`,
          sql`${touched} > ${now.toISOString()}::timestamptz`,
        ),
        input.after === null
          ? undefined
          : gt(edgeCommandRequests.id, input.after),
        input.exclude.length === 0
          ? undefined
          : notInArray(edgeCommandRequests.id, [...input.exclude]),
      ),
    )
    .orderBy(asc(edgeCommandRequests.id))
    .limit(input.limit);
}

/** Days body and result of a settled command are kept (guard trigger: 30). */
export const EDGE_COMMAND_REQUEST_RETENTION_DAYS = 30;
const PURGE_BATCH = 500;

/**
 * Forgets body and result of commands settled over the retention window; the
 * key, digest, state and code stay. Returns the number of rows, at most one
 * batch. `now` is the trusted clock's `purgeSafeNow`, so a wall clock set
 * forward forgets nothing early.
 */
export async function purgeSettledEdgeCommands(
  database: NodePgDatabase<typeof schema>,
  context: ScopedTenantContext,
  node: EdgeCommandNode,
  now: Date,
): Promise<number> {
  return withTenant(database, context, async (tx) => {
    const due = tx
      .select({ id: edgeCommandRequests.id })
      .from(edgeCommandRequests)
      .where(
        and(
          eq(edgeCommandRequests.tenantId, node.tenantId),
          eq(edgeCommandRequests.outletId, node.outletId),
          isNull(edgeCommandRequests.purgedAt),
          lte(
            edgeCommandRequests.settledAt,
            sql`least(${now.toISOString()}::timestamptz, now()) - make_interval(days => ${EDGE_COMMAND_REQUEST_RETENTION_DAYS}, secs => 1)`,
          ),
        ),
      )
      .limit(PURGE_BATCH);
    const rows = await tx
      .update(edgeCommandRequests)
      .set({ body: null, result: null, purgedAt: sql`now()` })
      .where(
        and(
          eq(edgeCommandRequests.tenantId, node.tenantId),
          eq(edgeCommandRequests.outletId, node.outletId),
          inArray(edgeCommandRequests.id, due),
        ),
      )
      .returning({ id: edgeCommandRequests.id });
    return rows.length;
  });
}
