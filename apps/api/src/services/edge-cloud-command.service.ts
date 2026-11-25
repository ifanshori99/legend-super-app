// Cloud side of the edge -> cloud command path (card F1, brief 1269).
//
// - Tenant, outlet and node come from the verified edge credential only. Every
//   call re-checks, in its own transaction and under a lock that a revocation
//   waits for, that the node is the active primary and that the calling edge
//   database is the one the link cursor follows.
// - The command row is inserted first, in the transaction that executes it. Its
//   primary key is the lock: a second POST or a status question of the same id
//   waits for the first and then reads the outcome it committed. A crash rolls
//   back the row together with the effect.
// - A kind handler may only write through the transaction it is given. An
//   external call (payment provider) does not belong in a handler.
// - A row of the same id that this outlet cannot see belongs to another outlet:
//   403, never executed.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { CoreError, toIsoDateTime, z } from "@starter/shared/core";
import {
  EDGE_COMMAND_MAX_SKEW_MS,
  EDGE_COMMAND_MAX_TTL_MS,
  EDGE_COMMAND_TEST_KIND,
  edgeCommandBodySchema,
  edgeCommandOutcomeSchema,
  edgeTestEchoPayloadSchema,
  type EdgeCommandBody,
  type EdgeCommandOutcome,
  type EdgeCommandStatusRequest,
} from "@starter/shared/edge";
import type * as schema from "../db/schema";
import { edgeCommandExecutions, edgeNodes, syncCursors } from "../db/schema";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { edgeNodeContext } from "./edge-node.service.ts";
import type { EdgeTx } from "./edge-queue.service.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";

type Database = NodePgDatabase<typeof schema>;
type ExecutionRow = typeof edgeCommandExecutions.$inferSelect;

/** A kind's final "no": its writes are rolled back, the code is recorded. */
export class EdgeCommandRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Edge command refused (${code})`);
    this.name = "EdgeCommandRefusal";
    this.code = code;
  }
}

export type EdgeCommandHandler = {
  readonly payload: z.ZodType;
  execute(
    tx: EdgeTx,
    input: {
      readonly node: VerifiedEdgeNode;
      readonly commandId: string;
      readonly payload: unknown;
    },
  ): Promise<Record<string, unknown>>;
};
export type EdgeCommandHandlers = Readonly<Record<string, EdgeCommandHandler>>;

/** Kinds this cloud serves. Later cards add theirs. */
export const EDGE_COMMAND_HANDLERS: EdgeCommandHandlers = {
  [EDGE_COMMAND_TEST_KIND]: {
    payload: edgeTestEchoPayloadSchema,
    async execute(_tx, input) {
      return edgeTestEchoPayloadSchema.parse(input.payload);
    },
  },
};

function parseBody(bytes: Uint8Array): EdgeCommandBody {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CoreError("VALIDATION_ERROR", "Isi perintah tidak valid.");
  }
  const body = edgeCommandBodySchema.safeParse(json);
  if (!body.success)
    throw new CoreError("VALIDATION_ERROR", "Isi perintah tidak valid.");
  return body.data;
}

async function assertActivePrimary(
  tx: EdgeTx,
  node: VerifiedEdgeNode,
  edgeInstanceId: string,
): Promise<void> {
  const [row] = await tx
    .select({ role: edgeNodes.role, status: edgeNodes.status })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, node.tenantId),
        eq(edgeNodes.outletId, node.outletId),
        eq(edgeNodes.id, node.edgeNodeId),
      ),
    )
    .for("share");
  if (row?.role !== "primary" || row.status !== "active")
    throw new HttpError(
      403,
      "EDGE_NOT_PRIMARY",
      "Hanya edge node utama yang aktif boleh mengirim perintah.",
    );
  const [cursor] = await tx
    .select({ instanceId: syncCursors.peerInstanceId })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.tenantId, node.tenantId),
        eq(syncCursors.edgeNodeId, node.edgeNodeId),
        eq(syncCursors.direction, "edge_to_cloud"),
      ),
    );
  if (!cursor?.instanceId || cursor.instanceId !== edgeInstanceId)
    throw new HttpError(
      403,
      "EDGE_INSTANCE_MISMATCH",
      "Database edge ini bukan yang terhubung ke cloud.",
    );
}

/** Claims the id, or reads the row that already holds it. */
async function claim(
  tx: EdgeTx,
  node: VerifiedEdgeNode,
  values: {
    id: string;
    edgeInstanceId: string;
    kind: string;
    bodySha256: string;
    status: "executing" | "absent";
  },
): Promise<{ inserted: boolean; row: ExecutionRow }> {
  const [inserted] = await tx
    .insert(edgeCommandExecutions)
    .values({
      tenantId: node.tenantId,
      outletId: node.outletId,
      edgeNodeId: node.edgeNodeId,
      ...values,
      decidedAt: values.status === "absent" ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { inserted: true, row: inserted };
  const [existing] = await tx
    .select()
    .from(edgeCommandExecutions)
    .where(
      and(
        eq(edgeCommandExecutions.tenantId, node.tenantId),
        eq(edgeCommandExecutions.id, values.id),
      ),
    );
  if (!existing || existing.edgeNodeId !== node.edgeNodeId)
    throw new HttpError(
      403,
      "EDGE_COMMAND_FORBIDDEN",
      "Perintah ini milik outlet atau edge node lain.",
    );
  if (
    existing.bodySha256 !== values.bodySha256 ||
    existing.kind !== values.kind
  )
    throw new HttpError(
      409,
      "EDGE_COMMAND_KEY_REUSED",
      "Kunci perintah sudah dipakai untuk isi lain.",
    );
  return { inserted: false, row: existing };
}

function toOutcome(row: ExecutionRow): EdgeCommandOutcome {
  if (row.status === "executing" || row.decidedAt === null)
    throw new HttpError(
      409,
      "EDGE_COMMAND_IN_PROGRESS",
      "Perintah masih diproses.",
    );
  return edgeCommandOutcomeSchema.parse({
    id: row.id,
    kind: row.kind,
    bodySha256: row.bodySha256,
    status: row.status,
    decidedAt: toIsoDateTime(row.decidedAt),
    ...(row.status === "succeeded" ? { result: row.result } : {}),
    ...(row.status === "refused" ? { code: row.code } : {}),
  });
}

type Decision =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "refused"; code: string }
  | { status: "expired" };

async function decide(
  tx: EdgeTx,
  node: VerifiedEdgeNode,
  body: EdgeCommandBody,
  handlers: EdgeCommandHandlers,
): Promise<Decision> {
  const handler = Object.hasOwn(handlers, body.kind)
    ? handlers[body.kind]
    : undefined;
  const payload = handler?.payload.safeParse(body.payload);
  // Not recorded: the insert rolls back, so the key stays unused.
  if (!handler || !payload?.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Jenis atau isi perintah tidak didukung.",
    );
  // The clock is read after the claim, so time spent waiting for it counts.
  const now = Date.now();
  const expiresAt = Date.parse(body.expiresAt);
  if (now >= expiresAt) return { status: "expired" };
  if (expiresAt > now + EDGE_COMMAND_MAX_TTL_MS + EDGE_COMMAND_MAX_SKEW_MS)
    return { status: "refused", code: "EXPIRY_OUT_OF_RANGE" };
  try {
    const result = await tx.transaction((savepoint) =>
      handler.execute(savepoint, {
        node,
        commandId: body.id,
        payload: payload.data,
      }),
    );
    return { status: "succeeded", result };
  } catch (error) {
    if (error instanceof EdgeCommandRefusal)
      return { status: "refused", code: error.code };
    throw error;
  }
}

/** Executes one command at most once; a replay answers the recorded outcome. */
export async function executeEdgeCommand(
  database: Database,
  node: VerifiedEdgeNode,
  input: { edgeInstanceId: string; bytes: Uint8Array },
  handlers: EdgeCommandHandlers = EDGE_COMMAND_HANDLERS,
): Promise<EdgeCommandOutcome> {
  const body = parseBody(input.bytes);
  const bodySha256 = createHash("sha256").update(input.bytes).digest("hex");
  return withTenant(database, edgeNodeContext(node), async (tx) => {
    await assertActivePrimary(tx, node, input.edgeInstanceId);
    const claimed = await claim(tx, node, {
      id: body.id,
      edgeInstanceId: input.edgeInstanceId,
      kind: body.kind,
      bodySha256,
      status: "executing",
    });
    if (!claimed.inserted) return toOutcome(claimed.row);
    const decision = await decide(tx, node, body, handlers);
    const [decided] = await tx
      .update(edgeCommandExecutions)
      .set({ ...decision, decidedAt: new Date() })
      .where(
        and(
          eq(edgeCommandExecutions.tenantId, node.tenantId),
          eq(edgeCommandExecutions.id, body.id),
        ),
      )
      .returning();
    if (!decided) throw new Error("Edge command row disappeared");
    return toOutcome(decided);
  });
}

/**
 * The outcome of an id. An id the cloud does not know is tombstoned in the same
 * statement (`absent`), so a POST that arrives later can never execute it.
 */
export async function settleEdgeCommandStatus(
  database: Database,
  node: VerifiedEdgeNode,
  input: {
    edgeInstanceId: string;
    commandId: string;
    request: EdgeCommandStatusRequest;
  },
): Promise<EdgeCommandOutcome> {
  return withTenant(database, edgeNodeContext(node), async (tx) => {
    await assertActivePrimary(tx, node, input.edgeInstanceId);
    const { row } = await claim(tx, node, {
      id: input.commandId,
      edgeInstanceId: input.edgeInstanceId,
      ...input.request,
      status: "absent",
    });
    return toOutcome(row);
  });
}
