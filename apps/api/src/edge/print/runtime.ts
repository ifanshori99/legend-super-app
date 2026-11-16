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
import { withTenant } from "../../db/tenant.ts";
import {
  createUlid,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../../services/edge-queue.service.ts";
import { getEdgeRuntimeState } from "../runtime.ts";
import {
  createPrintAgent,
  setPrintAlertNotifier,
  type PrintAgent,
  type PrintAlertNotifier,
} from "./agent.ts";
import { createDbPrintStore } from "./store.ts";
import { createKdsPrintFallback } from "./kds-fallback.ts";
import { defaultTransportFactory } from "./transport.ts";

let current: PrintAgent | null = null;

export function createPrintAlertNotifier(
  context: ScopedTenantContext,
  outletId: OutletId,
  edgeNodeId: string,
): PrintAlertNotifier {
  const eventIds = new WeakMap<object, string>();
  return async (alert, tx) => {
    if (alert.kind !== "printer_offline" && alert.kind !== "job_failed") return;
    const id = alert.id ?? eventIds.get(alert) ?? createUlid();
    eventIds.set(alert, id);
    const enqueue = (tx: EdgeTx) =>
      enqueueEdgeEvent(tx, context, {
        edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: {
          id,
          tenantId: context.tenant.tenantId,
          outletId,
          name: "print_alert.raised",
          version: 1,
          aggregateType: "print_alert",
          aggregateId: id,
          sequence: 1,
          occurredAt: alert.occurredAt.toISOString(),
          actor: { type: "system" },
          deviceId: null,
          idempotencyKey: `print_alert:${id}`,
          payloadSchemaRef: "print_alert.raised.v1",
          payload: { kind: alert.kind, subjectId: alert.subjectId },
        },
      });
    if (tx) await enqueue(tx);
    else await withTenant(db, context, enqueue);
  };
}

export function getEdgePrintAgent(): PrintAgent | null {
  return current;
}

/** Starts the agent when this process is a provisioned edge node; no-op otherwise. */
export function startEdgePrintAgent(): { stop(): Promise<void> } {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode || !runtime.identity || current)
    return { stop: async () => {} };
  setPrintAlertNotifier(
    createPrintAlertNotifier(
      runtime.identity.context,
      outletIdSchema.parse(runtime.identity.scope.outletId),
      runtime.identity.scope.edgeNodeId,
    ),
  );
  const agent = createPrintAgent({
    store: createDbPrintStore({ db, context: runtime.identity.context }),
    transportFor: defaultTransportFactory,
    sweepStationTickets: createKdsPrintFallback({
      db,
      context: runtime.identity.context,
      outletId: outletIdSchema.parse(runtime.identity.scope.outletId),
    }),
  });
  agent.start();
  current = agent;
  return {
    async stop() {
      await agent.stop();
      if (current === agent) {
        current = null;
        setPrintAlertNotifier(null);
      }
    },
  };
}
