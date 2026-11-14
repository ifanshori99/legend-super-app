// Built-in worker transport (bead legend-18qw). No new HTTP ingest exists: the
// authenticated ingest is the edge link (/api/edge-link). Durable acks are the
// domain_event_consumptions row (local) and edge_outbound_queue +
// sync_cursors.acked_out_seq (wire).
//
//   `identity` (session events) is a local sink in cloud and edge alike.
//   cloud: `cloud-sync` is a local sink (the consumption row is the ack, the
//          transport does nothing, except that `tenant.status_changed` and
//          `tenant.package_changed` throw: they belong to the control-plane
//          stream, which the worker consumes itself and never passes here).
//          Any other destination, or a row with a direction, throws so the outbox retries and then dead-letters.
//   edge:  `cloud-sync` rows are queued edge_to_cloud on the consumption
//          transaction; the link drains them to the cloud.
//
// Outbox sequences are allocated in the producer's transaction, so a gap is a
// producer bug no peer can fill: requestMissing only records it durably.
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema/index.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { recordOutboxGapRequest } from "../services/core-outbox-gaps.ts";
import {
  EdgeOutletRequiredError,
  type GapRequest,
} from "../services/core-outbox.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";

type Database = NodePgDatabase<typeof schema>;

const SYNC_DESTINATION = "cloud-sync";
// legend-83ll: session events are cloud-local; the consumer runs in the
// consumption transaction and the consumption row is the ack. Never synced.
const IDENTITY_DESTINATION = "identity";

export type OutboxRoute = {
  destination: string;
  direction: string | null;
  peerId: string | null;
};

export type BuiltinWorkerTransport = {
  deliverEvent(
    context: ScopedTenantContext,
    event: EventEnvelope,
    key: string,
    tx: EdgeTx,
    route: OutboxRoute,
  ): Promise<void>;
  requestMissing(context: ScopedTenantContext, gap: GapRequest): Promise<void>;
};

export function createBuiltinWorkerTransport(options: {
  database: Database;
  env: Record<string, string | undefined>;
}): BuiltinWorkerTransport {
  const parsed = parseEdgeRuntimeConfig(options.env);
  if (!parsed.ok)
    throw new Error(
      `Invalid edge runtime configuration: ${parsed.problems.join("; ")}`,
    );
  const edge = parsed.config.edgeMode
    ? parseEdgeCredential(parsed.config.credential)
    : null;
  if (parsed.config.edgeMode && !edge)
    throw new Error("Invalid edge runtime configuration: EDGE_NODE_CREDENTIAL");

  return {
    async deliverEvent(context, event, _key, tx, route) {
      assertTrustedScopedContext(context);
      if (route.direction !== null)
        throw new Error("Unsupported outbox direction");
      if (route.destination === IDENTITY_DESTINATION) return;
      if (route.destination !== SYNC_DESTINATION)
        throw new Error(`Unsupported outbox destination ${route.destination}`);
      if (!edge) {
        // 488 item 9: tenant lifecycle events travel the control-plane stream.
        // On `cloud-sync` the no-op sink below would mark them delivered with
        // no consumer, so refuse (retry, then dead-letter) instead.
        if (
          event.name === "tenant.status_changed" ||
          event.name === "tenant.package_changed"
        )
          throw new Error(`${event.name} must use the control-plane stream`);
        return;
      }
      if (event.tenantId !== edge.tenantId)
        throw new Error("Event tenant does not match the edge credential");
      if (!event.outletId) throw new EdgeOutletRequiredError();
      await enqueueEdgeEvent(tx, context, {
        edgeNodeId: edge.edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event,
      });
    },
    async requestMissing(context, gap) {
      assertTrustedScopedContext(context);
      await recordOutboxGapRequest(options.database, context, gap);
    },
  };
}
