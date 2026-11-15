// legend-x2c0x: a dead-lettered local event still belongs to its aggregate.
// Removing its queue row must not turn the peer's next event into a gap.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createSecondTenant } from "./tenant-isolation-harness.ts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createDbLinkStore,
  defaultLastSequence,
} from "../edge/db-link-store.ts";
import type { EdgeEventApplier } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";

let tenantId = tenantIdSchema.parse(cafeLegendFixtures.tenant.id);
let outletId = outletIdSchema.parse(cafeLegendFixtures.outlets[0].id);
let context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletId] },
);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const registeredNodes: string[] = [];
afterEach(async () => {
  for (const id of registeredNodes.splice(0))
    await revokeEdgeNode(context, randomUUID(), {
      edgeNodeId: id,
      reason: "Test cleanup",
    });
});
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const isolated = await createSecondTenant(owner, "last-sequence");
  tenantId = tenantIdSchema.parse(isolated.tenantId);
  outletId = outletIdSchema.parse(isolated.outletId);
  context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletId] },
  );
});
afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

let clock = Date.parse("2026-11-15T01:00:00Z");
function event(sequence: number, aggregateId: string): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId,
    outletId,
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `last-sequence-deadletter-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
}

async function deadLetteredAggregate() {
  const registered = await registerEdgeNode(context, randomUUID(), {
    outletId,
    role: "standby",
    label: `Last sequence ${randomUUID()}`,
  });
  registeredNodes.push(registered.edgeNode.id);
  const node = { tenantId, outletId, edgeNodeId: registered.edgeNode.id };
  const first = event(1, randomUUID());
  const apply = vi.fn<EdgeEventApplier<EdgeTx>["apply"]>(async () => {});
  const store = createDbLinkStore({
    database: db,
    context,
    node,
    outboundDirection: "edge_to_cloud",
    classify: () => "transaction_event",
    applier: { apply },
  });
  const queued = await withTenant(db, context, (tx) =>
    enqueueEdgeEvent(tx, context, {
      edgeNodeId: node.edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
      event: first,
    }),
  );
  await store.deadLetterOutbound({
    linkSeq: queued.linkSeq,
    event: first,
    bytes: 5 * 1024 * 1024,
    reason: "frame_too_large",
  });
  return { store, node, first, apply };
}

it("legend-x2c0x retains the transaction high-water mark in dead letters without changing master-data authority", async () => {
  const { node, first, store } = await deadLetteredAggregate();
  const last = await withTenant(db, context, (tx) =>
    defaultLastSequence(
      tx,
      node.edgeNodeId,
      "cloud_to_edge",
      "transaction_event",
      first,
    ),
  );
  expect(last).toBe(1);
  const masterLast = await withTenant(db, context, (tx) =>
    defaultLastSequence(
      tx,
      node.edgeNodeId,
      "cloud_to_edge",
      "master_data",
      first,
    ),
  );
  expect(masterLast).toBe(0);
  expect(
    (await store.listDeadLetters()).some(
      (entry) => entry.event.id === first.id,
    ),
  ).toBe(true);
});

it("legend-x2c0x applies the peer's next event after a local predecessor leaves the outbound queue", async () => {
  const { store, first, apply } = await deadLetteredAggregate();
  const next = event(2, first.aggregateId);
  await store.applyInbound({
    fromSeq: 0,
    toSeq: 1,
    events: [{ linkSeq: 1, event: next }],
  });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0]?.[1]).toEqual(next);
  expect(
    (await store.listDeadLetters()).some(
      (entry) => entry.event.id === first.id,
    ),
  ).toBe(true);
});
