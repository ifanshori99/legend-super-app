// Edge side of the edge -> cloud command path (card F1, brief 1269): sending.
//
// - `send` commits the attempt first, then POSTs the frozen bytes. It never
//   builds a body and never makes a key: a repeat sends the same bytes.
// - `resolve` only asks the status of an id. The cloud tombstones an id it does
//   not know, so the answer is final either way.
// - Only an outcome of the same id, kind and bytes settles a command. Anything
//   else (no answer, any error status, an answer about something else) leaves it
//   `unknown`, which keeps its subject locked.
// - A standby never sends.
import { CoreError } from "@starter/shared/core";
import {
  EDGE_COMMAND_INSTANCE_HEADER,
  EDGE_COMMAND_PATH,
  edgeCommandOutcomeResponseSchema,
} from "@starter/shared/edge";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { withTenant } from "../db/tenant.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { cloudPostBytes, EdgeCloudHttpError } from "./cloud-http.ts";
import {
  listOpenEdgeCommands,
  markEdgeCommandAttempt,
  readEdgeCommand,
  settleEdgeCommand,
  type EdgeCommandNode,
  type EdgeCommandRequest,
} from "./cloud-command-store.ts";

/** Commands asked per `resolveOpen` run. */
const RESOLVE_BATCH = 50;

export type EdgeCommandClientOptions = {
  database: NodePgDatabase<typeof schema>;
  node: EdgeCommandNode;
  role: "primary" | "standby";
  /** `edge_nodes.instance_id` of this edge database. */
  edgeInstanceId: string;
  /** EDGE_CLOUD_URL (ws:// or wss://). */
  cloudUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Why an attempt gave no outcome; codes only, never contents. */
  onError?: (error: unknown) => void;
};

export type EdgeCommandClient = {
  /** POST the frozen bytes; the stored command afterwards. */
  send(id: string): Promise<EdgeCommandRequest>;
  /** Ask the status of an open command; the stored command afterwards. */
  resolve(id: string): Promise<EdgeCommandRequest>;
  /** Ask the status of every open command of this node. */
  resolveOpen(): Promise<{ settled: number; open: number }>;
};

const isOpen = (row: EdgeCommandRequest) =>
  row.status === "pending" || row.status === "unknown";

export function createEdgeCommandClient(
  options: EdgeCommandClientOptions,
): EdgeCommandClient {
  const { node } = options;
  const context = edgeNodeContext(node);
  const run = <T>(work: (tx: EdgeTx) => Promise<T>) =>
    withTenant(options.database, context, work);

  function assertPrimary(): void {
    if (options.role !== "primary")
      throw new CoreError(
        "CONFLICT",
        "Edge node cadangan tidak boleh mengirim perintah.",
      );
  }

  function found(row: EdgeCommandRequest | null): EdgeCommandRequest {
    if (!row) throw new CoreError("NOT_FOUND", "Perintah tidak ditemukan.");
    return row;
  }

  /** One POST; the stored row afterwards, unchanged when nothing was proven. */
  async function exchange(
    row: EdgeCommandRequest,
    path: string,
    body: string,
  ): Promise<EdgeCommandRequest> {
    let answer: unknown;
    try {
      answer = await cloudPostBytes({
        cloudUrl: options.cloudUrl,
        credential: options.credential,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        path,
        headers: { [EDGE_COMMAND_INSTANCE_HEADER]: options.edgeInstanceId },
        body: new TextEncoder().encode(body),
      });
    } catch (error) {
      options.onError?.(error);
      return row;
    }
    const parsed = edgeCommandOutcomeResponseSchema.safeParse(answer);
    const outcome = parsed.success ? parsed.data.data : null;
    if (
      outcome === null ||
      outcome.id !== row.id ||
      outcome.kind !== row.kind ||
      outcome.bodySha256 !== row.bodySha256
    ) {
      options.onError?.(new EdgeCloudHttpError("BAD_OUTCOME"));
      return row;
    }
    return found(await run((tx) => settleEdgeCommand(tx, node, outcome)));
  }

  async function ask(row: EdgeCommandRequest): Promise<EdgeCommandRequest> {
    return exchange(
      row,
      `${EDGE_COMMAND_PATH}/${row.id}/status`,
      JSON.stringify({ kind: row.kind, bodySha256: row.bodySha256 }),
    );
  }

  return {
    async send(id) {
      assertPrimary();
      const row = found(
        await run((tx) => markEdgeCommandAttempt(tx, node, id)),
      );
      return isOpen(row) ? exchange(row, EDGE_COMMAND_PATH, row.body) : row;
    },
    async resolve(id) {
      assertPrimary();
      const row = found(await run((tx) => readEdgeCommand(tx, node, id)));
      return isOpen(row) ? ask(row) : row;
    },
    async resolveOpen() {
      assertPrimary();
      const rows = await run((tx) =>
        listOpenEdgeCommands(tx, node, RESOLVE_BATCH),
      );
      let settled = 0;
      for (const row of rows) if (!isOpen(await ask(row))) settled += 1;
      return { settled, open: rows.length - settled };
    },
  };
}
