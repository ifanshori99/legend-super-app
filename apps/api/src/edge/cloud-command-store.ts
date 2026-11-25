// Edge side of the edge -> cloud command path (card F1, brief 1269): the
// durable record. A command is frozen in the caller's transaction (id, exact
// body text), so the bill it locks and the command commit together. The state
// moves pending -> unknown (committed BEFORE the first send) -> final outcome.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CoreError, createUlid } from "@starter/shared/core";
import {
  EDGE_COMMAND_MAX_BYTES,
  edgeCommandBodySchema,
  type EdgeCommandOutcome,
} from "@starter/shared/edge";
import { edgeCommandRequests } from "../db/schema";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import type { VerifiedEdgeNode } from "../services/staff-pin-sync.ts";

/** The local node the command belongs to (from the node's own credential). */
export type EdgeCommandNode = Pick<
  VerifiedEdgeNode,
  "tenantId" | "outletId" | "edgeNodeId"
>;
export type EdgeCommandRequest = typeof edgeCommandRequests.$inferSelect;
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
): Promise<EdgeCommandRequest> {
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
    })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new CoreError(
      "CONFLICT",
      "Masih ada perintah ke cloud yang belum selesai.",
    );
  return row;
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

/** Records the cloud's outcome once; an already settled row stays as it is. */
export async function settleEdgeCommand(
  tx: EdgeTx,
  node: EdgeCommandNode,
  outcome: EdgeCommandOutcome,
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
  return row ?? readEdgeCommand(tx, node, outcome.id);
}

/** Every open command of this node, oldest first (recovery after a restart). */
export async function listOpenEdgeCommands(
  tx: EdgeTx,
  node: EdgeCommandNode,
  limit: number,
): Promise<EdgeCommandRequest[]> {
  return tx
    .select()
    .from(edgeCommandRequests)
    .where(
      and(
        eq(edgeCommandRequests.tenantId, node.tenantId),
        eq(edgeCommandRequests.outletId, node.outletId),
        eq(edgeCommandRequests.edgeNodeId, node.edgeNodeId),
        inArray(edgeCommandRequests.status, OPEN_STATUSES),
      ),
    )
    .orderBy(asc(edgeCommandRequests.createdAt))
    .limit(limit);
}
