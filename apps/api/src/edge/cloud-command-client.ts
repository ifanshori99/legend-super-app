// Edge side of the edge -> cloud command path (card F1, brief 1269): sending.
//
// - `send` commits the attempt first, then POSTs the frozen bytes. It never
//   builds a body and never makes a key: a repeat sends the same bytes.
// - A repeat is sent only while the command is not expired (local clock); after
//   that, and in `resolve` and `resolveOpen`, only the status is asked.
// - `resolve` only asks the status of an id. The cloud tombstones an id it does
//   not know, so the answer is final either way.
// - Only an outcome of the same id, kind and bytes settles a command. Anything
//   else (no answer, any error status, an answer about something else) leaves it
//   `unknown`, which keeps its subject locked. Settling and applying the outcome
//   (`onSettled` of the kind) is one transaction.
// - A standby never sends.
import { CoreError } from "@starter/shared/core";
import {
  EDGE_COMMAND_CLOCK_HEADER,
  EDGE_COMMAND_INSTANCE_HEADER,
  EDGE_COMMAND_PATH,
  EDGE_COMMAND_TEST_KIND,
  edgeCommandBodySchema,
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
  type EdgeCommandSettledHooks,
} from "./cloud-command-store.ts";

/** Commands asked per `resolveOpen` run. */
const RESOLVE_BATCH = 50;
/** `resolveOpen` leaves a command alone this long after its last send. */
const RESOLVE_MIN_AGE_MS = 30_000;

/** Kinds this edge settles. Later cards add theirs. */
export const EDGE_COMMAND_SETTLED_HOOKS: EdgeCommandSettledHooks = {
  // Changes no business data.
  [EDGE_COMMAND_TEST_KIND]: async () => {},
};

export type EdgeCommandClientOptions = {
  database: NodePgDatabase<typeof schema>;
  node: EdgeCommandNode;
  role: "primary" | "standby";
  /** `edge_nodes.instance_id` of this edge database. */
  edgeInstanceId: string;
  /** EDGE_CLOUD_URL (ws:// or wss://). */
  cloudUrl: string;
  credential: string;
  /** Per kind: applies the outcome in the settling transaction. */
  onSettled: EdgeCommandSettledHooks;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Why an attempt gave no outcome; codes only, never contents. */
  onError?: (error: unknown) => void;
  /** Test seams. */
  resolveBatch?: number;
  resolveMinAgeMs?: number;
};

export type EdgeCommandClient = {
  /** POST the frozen bytes; the stored command afterwards. */
  send(id: string): Promise<EdgeCommandRequest>;
  /** Ask the status of an open command; the stored command afterwards. */
  resolve(id: string): Promise<EdgeCommandRequest>;
  /**
   * Ask the status of open commands of this node, a batch per run; the next run
   * goes on where this one stopped. Stops when the cloud cannot be reached.
   */
  resolveOpen(): Promise<{ settled: number; open: number }>;
};

const isOpen = (row: EdgeCommandRequest) =>
  row.status === "pending" || row.status === "unknown";

const isExpired = (body: string) =>
  Date.now() >=
  Date.parse(edgeCommandBodySchema.parse(JSON.parse(body)).expiresAt);

const isUnreachable = (error: unknown) =>
  error instanceof EdgeCloudHttpError &&
  (error.code === "NETWORK" || error.code === "TIMEOUT");

export function createEdgeCommandClient(
  options: EdgeCommandClientOptions,
): EdgeCommandClient {
  const { node } = options;
  const context = edgeNodeContext(node);
  const run = <T>(work: (tx: EdgeTx) => Promise<T>) =>
    withTenant(options.database, context, work);
  /** Requests of this client in progress, per command id. */
  const inFlight = new Map<string, number>();
  let lastAsked: string | null = null;

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

  async function tracked<T>(id: string, work: () => Promise<T>): Promise<T> {
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (inFlight.get(id) ?? 1) - 1;
      if (left > 0) inFlight.set(id, left);
      else inFlight.delete(id);
    }
  }

  /** One POST; the stored row afterwards, unchanged when nothing was proven. */
  async function exchange(
    row: EdgeCommandRequest,
    path: string,
    body: string,
    onUnreachable?: () => void,
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
        headers: {
          [EDGE_COMMAND_INSTANCE_HEADER]: options.edgeInstanceId,
          [EDGE_COMMAND_CLOCK_HEADER]: new Date().toISOString(),
        },
        body: new TextEncoder().encode(body),
      });
    } catch (error) {
      if (isUnreachable(error)) onUnreachable?.();
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
    try {
      return found(
        await run((tx) =>
          settleEdgeCommand(tx, node, outcome, options.onSettled),
        ),
      );
    } catch {
      // Rolled back: the command is still open. The code only, the cause can
      // hold contents.
      options.onError?.(new EdgeCloudHttpError("SETTLE_FAILED"));
      return row;
    }
  }

  async function ask(
    row: EdgeCommandRequest,
    onUnreachable?: () => void,
  ): Promise<EdgeCommandRequest> {
    return exchange(
      row,
      `${EDGE_COMMAND_PATH}/${row.id}/status`,
      JSON.stringify({ kind: row.kind, bodySha256: row.bodySha256 }),
      onUnreachable,
    );
  }

  return {
    async send(id) {
      assertPrimary();
      return tracked(id, async () => {
        const stored = found(await run((tx) => readEdgeCommand(tx, node, id)));
        if (
          stored.status === "unknown" &&
          stored.body !== null &&
          isExpired(stored.body)
        )
          return ask(stored);
        const row = found(
          await run((tx) => markEdgeCommandAttempt(tx, node, id)),
        );
        return isOpen(row) && row.body !== null
          ? exchange(row, EDGE_COMMAND_PATH, row.body)
          : row;
      });
    },
    async resolve(id) {
      assertPrimary();
      return tracked(id, async () => {
        const row = found(await run((tx) => readEdgeCommand(tx, node, id)));
        return isOpen(row) ? ask(row) : row;
      });
    },
    async resolveOpen() {
      assertPrimary();
      const limit = options.resolveBatch ?? RESOLVE_BATCH;
      const quietSince = new Date(
        Date.now() - (options.resolveMinAgeMs ?? RESOLVE_MIN_AGE_MS),
      );
      const list = (after: string | null, count: number) =>
        run((tx) =>
          listOpenEdgeCommands(tx, node, {
            limit: count,
            quietSince,
            after,
            exclude: [...inFlight.keys()],
          }),
        );
      const rows = await list(lastAsked, limit);
      if (lastAsked !== null && rows.length < limit) {
        const listed = new Set(rows.map((row) => row.id));
        for (const row of await list(null, limit - rows.length))
          if (!listed.has(row.id)) rows.push(row);
      }
      let settled = 0;
      let reachable = true;
      for (const row of rows) {
        if (!reachable) break;
        if (inFlight.has(row.id)) continue;
        lastAsked = row.id;
        const after = await tracked(row.id, () =>
          ask(row, () => {
            reachable = false;
          }),
        );
        if (!isOpen(after)) settled += 1;
      }
      return { settled, open: rows.length - settled };
    },
  };
}
