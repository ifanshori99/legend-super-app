// Panic alert push trigger (bead legend-kmjax, FAC-08). The notification rule
// for `panic_alert.raised` exists in worker/notification-adapters.ts, but only
// an event on the `notification` outbox destination reaches it. The cloud
// applier of the edge `raised` event (edge/panic-alert-applier.ts) must queue
// that event, like `facility_incident.raised` does, in the same transaction
// that stores the alert, and never twice for a replayed event.
//
// The edge is simulated as in panic-sync.test.ts: the envelope is delivered
// through the cloud link store (applyInbound) of a registered edge node.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { panicAlertIdFor } from "../services/panic-alert-outbox.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const actor = randomUUID();

let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let outletId: string;
let node: AuthenticatedEdgeNode;

const scope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** The `raised` envelope the edge queues (sequence 1 of the alert). */
function raisedEvent(
  options: {
    tenantId?: string;
    outlet?: string;
    payloadOutlet?: string;
    kind?: "press" | "test";
  } = {},
) {
  const tenantId = options.tenantId ?? tenant.tenantId;
  const outlet = options.outlet ?? outletId;
  const deviceId = randomUUID();
  const firstDeviceEventId = `evt-${randomUUID()}`;
  const alertId = panicAlertIdFor(tenantId, deviceId, firstDeviceEventId);
  const name = "panic_alert.raised";
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId,
    outletId: outlet,
    name,
    aggregateType: "panic_alert",
    aggregateId: alertId,
    sequence: 1,
    idempotencyKey: `${name}-${alertId}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      alertId,
      outletId: options.payloadOutlet ?? outlet,
      deviceId,
      unitId: null,
      firstDeviceEventId,
      kind: options.kind ?? "press",
      triggeredAt: null,
      receivedAt: new Date().toISOString(),
      unitCodeSnapshot: "P1",
      facilityNameSnapshot: "Fasilitas Uji",
      deviceLabelSnapshot: "Tombol Uji",
      linkOffline: false,
    },
  });
}
type Raised = ReturnType<typeof raisedEvent>;

async function deliver(events: Raised[]) {
  registerPanicAlertEdgeApplier();
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

type NotificationRow = {
  outlet_id: string;
  destination: string;
  event: { name: string; payload: { alertId: string; outletId: string } };
};

async function notificationRows(alertId: string): Promise<NotificationRow[]> {
  const { rows } = await owner.query<NotificationRow>(
    `SELECT outlet_id::text AS outlet_id, destination, event
       FROM domain_event_outbox
      WHERE aggregate_type = 'panic_alert' AND aggregate_id = $1
        AND destination = 'notification'`,
    [alertId],
  );
  return rows;
}

async function alertCount(alertId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM panic_alerts WHERE id = $1",
    [alertId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(
    `ptrig-${randomBytes(3).toString("hex")}`,
  );
  otherTenant = await createIsolatedTenant(
    `ptrig-${randomBytes(3).toString("hex")}`,
  );
  outletId = tenant.outletId;
  const registered = await registerEdgeNode(scope(), actor, {
    outletId,
    role: "primary",
    label: "Edge darurat push",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
}, 120_000);

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`,
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const id of [tenant.tenantId, otherTenant.tenantId]) {
      for (const { table_name } of rows)
        await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
          id,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

describe("panic_alert.raised queues the push notification", () => {
  it("queues one notification event, outlet-scoped, with the alert reference", async () => {
    const event = raisedEvent();
    await deliver([event]);

    const alertId = event.aggregateId;
    expect(await alertCount(alertId)).toBe(1);
    const rows = await notificationRows(alertId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outlet_id).toBe(outletId);
    expect(rows[0]!.event.name).toBe("panic_alert.raised");
    expect(rows[0]!.event.payload.alertId).toBe(alertId);
    expect(rows[0]!.event.payload.outletId).toBe(outletId);
  });

  it("queues a test alert too (the rule marks it UJI)", async () => {
    const event = raisedEvent({ kind: "test" });
    await deliver([event]);
    expect(await notificationRows(event.aggregateId)).toHaveLength(1);
  });

  it("does not queue a second notification when the event is delivered again", async () => {
    const event = raisedEvent();
    await deliver([event]);
    await deliver([event]);
    // The same alert re-raised under a new envelope id (a standby replay).
    await deliver([{ ...event, id: createUlid() }]);

    const alertId = event.aggregateId;
    expect(await alertCount(alertId)).toBe(1);
    expect(await notificationRows(alertId)).toHaveLength(1);
  });

  it("queues nothing for an event of another tenant", async () => {
    const event = raisedEvent({ tenantId: otherTenant.tenantId });
    await expect(deliver([event])).rejects.toThrow(/outside the node scope/);

    const alertId = event.aggregateId;
    expect(await alertCount(alertId)).toBe(0);
    expect(await notificationRows(alertId)).toHaveLength(0);
  });

  it("queues nothing for an outlet outside the edge node's scope", async () => {
    const event = raisedEvent({ outlet: otherTenant.outletId });
    await expect(deliver([event])).rejects.toThrow(/outside the node scope/);

    const alertId = event.aggregateId;
    expect(await alertCount(alertId)).toBe(0);
    expect(await notificationRows(alertId)).toHaveLength(0);
  });

  it("queues nothing when the payload outlet differs from the event outlet", async () => {
    const event = raisedEvent({ payloadOutlet: otherTenant.outletId });
    await deliver([event]);

    const alertId = event.aggregateId;
    expect(await alertCount(alertId)).toBe(0);
    expect(await notificationRows(alertId)).toHaveLength(0);
  });
});
