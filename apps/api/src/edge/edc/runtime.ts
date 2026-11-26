// EDC agent lifecycle on an edge node (bead legend-kwy6d, sub-brief 867). The
// edge process holds the terminals (LAN/serial), so the agent runs here and
// not in the cloud worker. One agent per outlet: the agent's own Postgres
// advisory lock refuses a second process for the same outlet, and only the
// primary node starts it (a standby never opens a terminal exchange).
//
// Callers:
// - server bootstrap: `startEdgeEdcAgent()` after `startEdgePrintAgent()` in
//   EDGE_MODE, and `stop()` on shutdown before `edgeRuntime.stop()`.
// - POS payment flow (legend-m0k): `getEdgeEdcAgent()`; null outside edge
//   mode, on a standby, when disabled, or when start failed.
//
// Fail-stop: the agent's default `onFatal` exits the process (code 1) when the
// outlet lock is lost with a sale on the wire. systemd restarts it
// (`deploy/edge/legend-edge.service`). Left alone on purpose: the wire marker.
//
// No permanent death without a sale on the wire: a failed start (outlet held by
// a dying process, database down) or a lock lost with no live call
// (`onOutletLost`) retries a fresh agent with backoff, like the Wi-Fi agent,
// until `stop()`. Without it one blip would leave the outlet without card
// payments until someone restarts the edge.
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../../config/env.ts";
import { db } from "../../db/index.ts";
import { logger } from "../../lib/logger.ts";
import {
  defaultWifiLockRetryDelayMs,
  getEdgeRuntimeState,
} from "../runtime.ts";
import { createEdcAgent, type EdcAgent } from "./agent.ts";
import { createDefaultEdcRegistry } from "./registry.ts";

/** How long one sale may stay on the wire. Passed to the agent explicitly so
 * the shutdown budget below always follows it. */
export const EDC_SALE_TIMEOUT_MS = 120_000;
/** Margin on top of the sale timeout for the rest of the shutdown. */
const EDC_SHUTDOWN_MARGIN_MS = 10_000;
const DEFAULT_SHUTDOWN_FORCE_MS = 5_000;

/** Force-exit timer of the graceful shutdown (server.ts). With the EDC agent
 * running it must outlast a sale on the wire: cutting `stop()` short would
 * lose the approval evidence of that sale. systemd `TimeoutStopSec` must be
 * larger still (deploy/edge/legend-edge.service). */
export function edgeShutdownForceMs(
  options: {
    enabled?: boolean;
    role?: "primary" | "standby";
    edgeMode?: boolean;
  } = {},
): number {
  const enabled = options.enabled ?? env.EDC_AGENT_ENABLED;
  const role = options.role ?? env.EDGE_NODE_ROLE;
  const edgeMode = options.edgeMode ?? env.EDGE_MODE;
  return enabled && edgeMode && role === "primary"
    ? EDC_SALE_TIMEOUT_MS + EDC_SHUTDOWN_MARGIN_MS
    : DEFAULT_SHUTDOWN_FORCE_MS;
}

let current: EdcAgent | null = null;
// True from a start call until its handle is stopped (a start in flight, a
// retry pending, or an agent running), so a second call is a no-op.
let running = false;

export function getEdgeEdcAgent(): EdcAgent | null {
  return current;
}

/** Tests only: the agent the POS ECR routes see (1269 E7). */
export function setEdgeEdcAgentForTests(agent: EdcAgent | null): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("setEdgeEdcAgentForTests is for tests only");
  current = agent;
}

/** The registry every production agent gets: never a simulator, and no bank
 * adapter until legend-vpx registers one. Empty means every ECR sale is
 * refused (`EDC_PROVIDER_UNKNOWN`) before a ledger row exists. */
export function createProductionEdcRegistry() {
  return createDefaultEdcRegistry({ simulator: false });
}

export type EdgeEdcAgentOptions = {
  /** Default `env.EDC_AGENT_ENABLED` (off by default). */
  enabled?: boolean;
  /** Default `env.EDGE_NODE_ROLE`. */
  role?: "primary" | "standby";
  /** Tests only; production builds the agent on the shared pool with the
   * production registry (no simulators, no bank adapters until legend-vpx).
   * `onOutletLost` must be passed to the agent's deps. */
  createAgent?: (hooks: { onOutletLost: () => void }) => EdcAgent;
  /** Tests only: delay before retry number `attempt` (0-based), in ms.
   * Default: the Wi-Fi agent backoff (1 s doubling, capped at 30 s). */
  retryDelayMs?: (attempt: number) => number;
};

function productionAgent(hooks: { onOutletLost: () => void }): EdcAgent {
  return createEdcAgent({
    db,
    registry: createProductionEdcRegistry(),
    saleTimeoutMs: EDC_SALE_TIMEOUT_MS,
    onOutletLost: hooks.onOutletLost,
  });
}

/** Starts the agent when this process is a provisioned, enabled, primary edge
 * node; no-op otherwise. A failed start (outlet held by another process,
 * database down) is logged and retried with backoff; the edge keeps running
 * meanwhile (no EDC agent, `getEdgeEdcAgent()` is null). The same holds when
 * the outlet lock is lost with no sale on the wire: the agent is dropped and
 * a fresh one is started. `stop()` ends the retries and stops the agent. */
export async function startEdgeEdcAgent(
  options: EdgeEdcAgentOptions = {},
): Promise<{ stop(): Promise<void> }> {
  const none = { stop: async () => {} };
  const enabled = options.enabled ?? env.EDC_AGENT_ENABLED;
  const role = options.role ?? env.EDGE_NODE_ROLE;
  const runtime = getEdgeRuntimeState();
  if (!enabled || role !== "primary") return none;
  if (!runtime.edgeMode || !runtime.identity || current || running) return none;
  const context: ScopedTenantContext = runtime.identity.context;
  const build = options.createAgent ?? productionAgent;
  const retryDelayMs = options.retryDelayMs ?? defaultWifiLockRetryDelayMs;
  running = true;

  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      inflight = tryStart();
    }, retryDelayMs(attempt++));
    retryTimer.unref();
  };

  async function tryStart(): Promise<void> {
    if (stopped) return;
    let agent: EdcAgent | null = null;
    // Lock lost before `start` resolved: `current` is not set yet.
    let lostEarly = false;
    const onOutletLost = () => {
      if (!agent || stopped) return;
      if (current !== agent) {
        lostEarly = true;
        return;
      }
      current = null;
      logger.warn("The EDC agent lost its outlet lock; starting a fresh one.");
      const old = agent;
      inflight = inflight.then(() => old.stop().catch(() => {}));
      attempt = 0;
      scheduleRetry();
    };
    try {
      agent = build({ onOutletLost });
      await agent.start(context);
      if (lostEarly) throw new Error("EDC outlet lock lost during start");
    } catch (error) {
      // Class only: driver errors can carry SQL parameters.
      const failure = error as { name?: unknown; code?: unknown };
      logger.error(
        {
          errName: typeof failure?.name === "string" ? failure.name : "Error",
          code: typeof failure?.code === "string" ? failure.code : undefined,
        },
        "The EDC agent could not start; the edge keeps running without it, retrying.",
      );
      // A partial start may hold an outlet lock: release it.
      await agent?.stop().catch(() => {});
      scheduleRetry();
      return;
    }
    if (stopped) {
      await agent.stop().catch(() => {});
      return;
    }
    attempt = 0;
    current = agent;
  }

  await tryStart();
  return {
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      try {
        await inflight;
        const agent = current;
        current = null;
        await agent?.stop();
      } finally {
        running = false;
      }
    },
  };
}
