// Print Agent lifecycle on an edge node (bead legend-46p; PRD v1.7 §3 F5
// "Print Agent", EDG-05). Starts one agent bound to the edge node's own
// tenant + outlet (from its credential, never from a request, TEN-02).
//
// Callers:
// - server bootstrap: `startEdgePrintAgent()` after `startEdgeRuntime()` in
//   EDGE_MODE, and `stop()` on shutdown (wiring is a follow-up bead).
// - POS receipt, KDS and shift services: `getEdgePrintAgent()` to enqueue a
//   job, route a station ticket (KDS-down fallback) or report a KDS heartbeat.
//   Null outside edge mode or before start.
import { db } from "../../db/index.ts";
import { getEdgeRuntimeState } from "../runtime.ts";
import { createPrintAgent, type PrintAgent } from "./agent.ts";
import { createDbPrintStore } from "./store.ts";
import { defaultTransportFactory } from "./transport.ts";

let current: PrintAgent | null = null;

export function getEdgePrintAgent(): PrintAgent | null {
  return current;
}

/** Starts the agent when this process is a provisioned edge node; no-op otherwise. */
export function startEdgePrintAgent(): { stop(): Promise<void> } {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode || !runtime.identity || current)
    return { stop: async () => {} };
  const agent = createPrintAgent({
    store: createDbPrintStore({ db, context: runtime.identity.context }),
    transportFor: defaultTransportFactory,
  });
  agent.start();
  current = agent;
  return {
    async stop() {
      if (current === agent) current = null;
      await agent.stop();
    },
  };
}
