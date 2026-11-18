// Edge node alarm over the edge event stream (beads legend-0cjzz, legend-uvnll;
// docs/design/edge-status-cloud.md D1-D4).
//
// Edge side: `createNodeAlarmEmitter` turns the device-registry "hard stale"
// state into ordered `edge_node_alarm.raised` / `.cleared` events in the
// edge's outbound queue. The durable state is the outbox itself: the last
// alarm row of this node (any status) says what was emitted last.
//
// Cloud side: `registerNodeAlarmEdgeApplier` applies those events in the link
// transaction (alert row plus owner notification). Tenant, outlet and node come
// from the edge credential, never from the payload.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CoreError,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  EDGE_NODE_ALARM_AGGREGATE,
  EDGE_NODE_ALARM_CLEARED,
  EDGE_NODE_ALARM_RAISED,
  edgeNodeAlarmClearedPayloadSchema,
  edgeNodeAlarmRaisedPayloadSchema,
  type EdgeNodeAlarmKind,
} from "@starter/shared/edge/node-alarm";
import { withTenant } from "../db/tenant.ts";
import {
  raiseEdgeNodeAlert,
  resolveEdgeNodeAlerts,
} from "../services/edge-node-alert.service.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";
import { notifyEdgeDeviceRegistryHardStale } from "../services/edge-sync-conflict-alert.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

const KIND: EdgeNodeAlarmKind = "device_registry_hard_stale";

// ------------------------------------------------------------------ edge side

type Database = Parameters<typeof withTenant>[0];

export type NodeAlarmRegistryState = {
  hardStale: boolean;
  /** Last successful registry pull; null when the replica never pulled. */
  lastPulledAt: Date | null;
  /** Boot time: the age base while there was no pull (design D2). */
  startedAt: Date;
};

export type NodeAlarmEmitterDeps = {
  /** The edge database. */
  database: Database;
  context: ScopedTenantContext;
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
  getDeviceRegistryState: () => NodeAlarmRegistryState;
  /** EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS. */
  maxStaleSeconds: number;
  now?: () => Date;
};

export type NodeAlarmEmitter = {
  /**
   * Queues at most one transition so the outbox matches the puller's state.
   * Calls are serialized. A failed enqueue rejects and keeps the last emitted
   * state, so the next call retries.
   */
  reconcile(): Promise<void>;
};

function alarmEventId(name: string, edgeNodeId: string, basis: string): string {
  const hex = createHash("sha256")
    .update(`${name}\0${edgeNodeId}\0${KIND}\0${basis}`)
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function createNodeAlarmEmitter(
  deps: NodeAlarmEmitterDeps,
): NodeAlarmEmitter {
  const now = deps.now ?? (() => new Date());
  // null = not read yet; otherwise whether the last emitted alarm is "raised".
  let lastRaised: boolean | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function loadLastRaised(): Promise<boolean> {
    const result = await withTenant(deps.database, deps.context, (tx) =>
      tx.execute(
        sql`SELECT event->>'name' AS name FROM edge_outbound_queue WHERE edge_node_id = ${deps.edgeNodeId}::uuid AND direction = 'edge_to_cloud' AND aggregate_type = ${EDGE_NODE_ALARM_AGGREGATE} ORDER BY link_seq DESC LIMIT 1`,
      ),
    );
    return result.rows[0]?.name === EDGE_NODE_ALARM_RAISED;
  }

  async function emit(raised: boolean, state: NodeAlarmRegistryState) {
    const name = raised ? EDGE_NODE_ALARM_RAISED : EDGE_NODE_ALARM_CLEARED;
    const lastPulledAt = state.lastPulledAt?.toISOString() ?? null;
    const basis = lastPulledAt ?? `boot:${state.startedAt.toISOString()}`;
    const id = alarmEventId(name, deps.edgeNodeId, basis);
    const event: EventEnvelope = {
      id,
      tenantId: deps.tenantId,
      outletId: deps.outletId,
      name,
      version: 1,
      aggregateType: EDGE_NODE_ALARM_AGGREGATE,
      aggregateId: id,
      sequence: 1,
      occurredAt: now().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${name}:${id}`,
      payloadSchemaRef: `${name}.v1`,
      payload: raised
        ? { kind: KIND, lastPulledAt, maxStaleSeconds: deps.maxStaleSeconds }
        : { kind: KIND, lastPulledAt },
    };
    await withTenant(deps.database, deps.context, (tx) =>
      enqueueEdgeEvent(tx, deps.context, {
        edgeNodeId: deps.edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event,
      }),
    );
    lastRaised = raised;
  }

  async function step(): Promise<void> {
    if (lastRaised === null) lastRaised = await loadLastRaised();
    const state = deps.getDeviceRegistryState();
    if (state.hardStale === lastRaised) return;
    await emit(state.hardStale, state);
  }

  return {
    reconcile() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await step();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

// ----------------------------------------------------------------- cloud side

function checkEnvelope(event: EventEnvelope, name: string): void {
  if (
    event.name !== name ||
    event.version !== 1 ||
    event.aggregateType !== EDGE_NODE_ALARM_AGGREGATE ||
    event.aggregateId !== event.id ||
    event.sequence !== 1
  )
    throw new CoreError("VALIDATION_ERROR", "Invalid edge node alarm event");
}

/** The edge clock is not trusted to move times forward. */
function cloudTime(occurredAt: string): Date {
  const at = new Date(occurredAt);
  const cloudNow = new Date();
  return at.getTime() > cloudNow.getTime() ? cloudNow : at;
}

export async function applyNodeAlarmRaised(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const payload = edgeNodeAlarmRaisedPayloadSchema.safeParse(event.payload);
  if (!payload.success)
    throw new CoreError("VALIDATION_ERROR", "Invalid edge node alarm event");
  checkEnvelope(event, EDGE_NODE_ALARM_RAISED);
  const tenantId = meta.context.tenant.tenantId;
  const at = cloudTime(event.occurredAt);
  await raiseEdgeNodeAlert(tx, {
    tenantId,
    outletId,
    edgeNodeId: meta.edgeNodeId,
    kind: payload.data.kind,
    at,
    detail: {
      lastPulledAt: payload.data.lastPulledAt,
      maxStaleSeconds: payload.data.maxStaleSeconds,
    },
    sourceEventId: event.id,
  });
  await notifyEdgeDeviceRegistryHardStale(
    tx,
    meta.context,
    {
      tenantId,
      outletId,
      edgeNodeId: meta.edgeNodeId,
      maxStaleSeconds: payload.data.maxStaleSeconds,
      lastPulledAt: payload.data.lastPulledAt,
    },
    new Date(),
    "cloud",
  );
}

export async function applyNodeAlarmCleared(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  await assertEdgeEventScope(tx, event, meta);
  const payload = edgeNodeAlarmClearedPayloadSchema.safeParse(event.payload);
  if (!payload.success)
    throw new CoreError("VALIDATION_ERROR", "Invalid edge node alarm event");
  checkEnvelope(event, EDGE_NODE_ALARM_CLEARED);
  await resolveEdgeNodeAlerts(tx, {
    tenantId: meta.context.tenant.tenantId,
    edgeNodeId: meta.edgeNodeId,
    kind: payload.data.kind,
    at: cloudTime(event.occurredAt),
  });
}

export function registerNodeAlarmEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    EDGE_NODE_ALARM_RAISED,
    applyNodeAlarmRaised,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    EDGE_NODE_ALARM_CLEARED,
    applyNodeAlarmCleared,
  );
  registerEdgeAggregateKind(EDGE_NODE_ALARM_AGGREGATE, "transaction_event");
}
