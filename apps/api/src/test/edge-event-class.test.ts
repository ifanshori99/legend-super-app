// Edge -> cloud event classification (beads legend-eadm + legend-niq9, tier K
// offline sync). Claim: `pos_override.*` and `staff_pin.*` rows of an edge node
// reach the cloud and one unclassifiable event must never hold the whole receive
// batch (cursor stall). Unknown events are parked per event with a supervisor
// alarm; known-but-not-yet-projected events are parked 'deferred'.
// legend-kyie: the access events are no longer parked; edge/access-applier.ts
// applies them (its own tests: edge-access-applier.test.ts). Here they only
// show that they never stall the link: these fixtures carry no valid payload,
// so each is refused as one `applier_refused` conflict.
//
// Assumptions (the brief does not pin them down):
// - "Alarm" is observable as rows in `notifications` for the outlet's supervisor
//   (the same path as edge_sync_conflict alerts). The category/title is the
//   implementer's choice, so the test counts notification rows of the tenant:
//   with exactly one supervisor, one alarm == one notification row.
// - Unknown aggregate types start with `zz_` (nothing registers them). The
//   alarm is sent once per event name and outlet per 24 hours, so each test
//   uses its own unknown name.
// - Alarm failure (B) is simulated at the database: a trigger that raises on
//   notification inserts for the test tenant only (dropped afterwards), so the
//   test does not depend on which module sends the alarm.
// Fixtures: one disposable tenant with one outlet, an edge node, one supervisor;
// all removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { inventoryEvents } from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  appendOutbox,
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
  replayOutbox,
} from "../services/core-outbox.ts";
import {
  alertBlockedOutboxAggregates,
  countBlockedOutboxAggregates,
} from "../services/core-outbox-dead-alert.ts";
import * as conflictAlerts from "../services/edge-sync-conflict-alert.ts";
import { logger } from "../lib/logger.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerAccessEdgeApplier } from "../edge/access-applier.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const supervisorUserId = randomUUID();
const supervisorRoleId = randomUUID();
let locationA: string;
let itemId: string;
let node: AuthenticatedEdgeNode;

/** Marker that must never appear in a notification (no payload leaks). */
const PAYLOAD_MARKER = "SECRET-PAYLOAD-9f3c";
const TRIGGER_FN = `eec_fail_fn_${randomBytes(4).toString("hex")}`;

let clock = Date.parse("2026-11-09T11:00:00.000Z");

/** An edge event of any name; the aggregate type is the name's first part. */
function edgeEvent(name: string, aggregateType?: string): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: aggregateType ?? name.split(".")[0]!,
    aggregateId: createUlid(clock),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:edge-event-class-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: { note: PAYLOAD_MARKER },
  };
}

function stockMoved(): { event: EventEnvelope; ledgerEntryId: string } {
  clock += 1_000;
  const ledgerEntryId = createUlid(clock);
  const occurredAt = new Date(clock).toISOString();
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: outletA,
    name: "stock.moved",
    version: 1,
    aggregateType: "stock",
    aggregateId: ledgerEntryId,
    sequence: 1,
    occurredAt,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `stock.moved:${ledgerEntryId}`,
    payloadSchemaRef: "stock.moved.v1",
    payload: {
      ledgerEntryId,
      inventoryItemId: itemId,
      locationId: locationA,
      movementType: "sale",
      quantity: "-2.0000",
      unitCostIdr: "1234.5678",
      batchId: null,
      sourceType: "order",
      sourceId: createUlid(clock),
      occurredAt,
    },
  }) as EventEnvelope;
  return { event, ledgerEntryId };
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function deliver(events: EventEnvelope[]) {
  const link = store();
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

async function count(query: string, params: unknown[]) {
  const { rows } = await owner.query<{ n: number }>(query, params);
  return rows[0]!.n;
}

async function parkedRows(eventId: string) {
  const { rows } = await owner.query<{
    event_name: string;
    aggregate_type: string;
    parked_reason: string;
  }>(
    "SELECT event_name, aggregate_type, parked_reason FROM edge_deferred_events WHERE event_id = $1::uuid",
    [ulidToUuid(eventId)],
  );
  return rows;
}

const parkedCount = () =>
  count(
    "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1",
    [tenantId],
  );
const notificationCount = () =>
  count("SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1", [
    tenantId,
  ]);
const conflictCount = () =>
  count(
    "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1",
    [tenantId],
  );
/** Notification rows of the tenant created from `since` on. */
async function notificationsSince(since: Date) {
  const { rows } = await owner.query<{
    user_id: string;
    outlet_id: string | null;
    title: string;
    body: string;
    link: string | null;
  }>(
    "SELECT user_id, outlet_id, title, body, link FROM notifications WHERE tenant_id = $1 AND created_at >= $2",
    [tenantId, since],
  );
  return rows;
}
const ledgerRows = (ledgerEntryId: string) =>
  count(
    "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, ulidToUuid(ledgerEntryId)],
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Event Class', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `event-class-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `event-class-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'EEC-01', 'EEC-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brand, entity],
  );
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'gr', 'gram') RETURNING id",
    [tenantId],
  );
  itemId = (
    await owner.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, 'Kopi Bubuk', 'Bahan Baku', 'raw_material', $2, false) RETURNING id`,
      [tenantId, uom.rows[0]!.id],
    )
  ).rows[0]!.id;
  locationA = (
    await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang', 'warehouse') RETURNING id",
      [tenantId, outletA],
    )
  ).rows[0]!.id;
  // One supervisor of the outlet: the alarm's only recipient.
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Supervisor EEC', $2, true)`,
    [supervisorUserId, `eec-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'supervisor'`,
    [supervisorRoleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No supervisor role template");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, supervisorUserId, supervisorRoleId, outletA],
  );
}

async function createBlockedHead(
  context: ReturnType<typeof establishScopedTenantContext>,
  destination: string,
) {
  const first = edgeEvent("order.paid", "order");
  const second = {
    ...edgeEvent("order.paid", "order"),
    aggregateId: first.aggregateId,
    sequence: 2,
  };
  const firstId = createUlid();
  for (const [id, event] of [
    [firstId, first],
    [createUlid(), second],
  ] as const) {
    await withTenant(db, context, (tx) =>
      appendOutbox(tx, context, {
        id,
        event,
        destination,
        direction: null,
        peerId: null,
      }),
    );
  }
  expect(
    await markOutboxDead(db, context, { outboxId: firstId, generation: 0 }),
  ).toBe(true);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
    ),
    actor,
    { outletId: outletA, role: "primary", label: "Utama Event Class" },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  // Registration order of registerEdgeLink (runtime.ts).
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerAccessEdgeApplier(); // legend-kyie (was parked deferred, legend-eadm)
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_deferred_events",
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_consumptions",
      "domain_event_offsets",
      "domain_event_replays",
      "domain_event_outbox",
      "stock_balances",
      "stock_ledger",
      "stock_locations",
      "inventory_items",
      "uoms",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query(`DELETE FROM "user" WHERE id = $1`, [supervisorUserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-eadm R reproduction: mixed batch does not stall the link", () => {
  it("pos_override.recorded, staff_pin.set, staff_pin.locked and an unknown aggregate do not block a later event", async () => {
    const posOverride = edgeEvent("pos_override.recorded");
    const pinSet = edgeEvent("staff_pin.set");
    const pinLocked = edgeEvent("staff_pin.locked");
    const unknown = edgeEvent("zz_repro.created");
    const { event: moved, ledgerEntryId } = stockMoved();
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const conflictsBefore = await conflictCount();

    // Whole batch applies in one call (it would reject and roll back on a stall).
    await deliver([posOverride, pinSet, pinLocked, unknown, moved]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 5);
    expect(await ledgerRows(ledgerEntryId)).toBe(1); // later event applied
    // The unknown event is stored for later; the access events go to their
    // applier (legend-kyie), which refuses these payload-less fixtures one by
    // one instead of stalling the batch.
    expect(await parkedRows(unknown.id)).toEqual([
      {
        event_name: unknown.name,
        aggregate_type: unknown.aggregateType,
        parked_reason: "unclassified",
      },
    ]);
    for (const event of [posOverride, pinSet, pinLocked])
      expect(await parkedRows(event.id), event.name).toHaveLength(0);
    expect(await conflictCount()).toBe(conflictsBefore + 3);
  });
});

describe("legend-eadm A classification and alarm", () => {
  it("pos_override.* and staff_pin.* are applied, never parked (legend-kyie)", async () => {
    const events = [
      edgeEvent("pos_override.recorded"),
      edgeEvent("staff_pin.set"),
      edgeEvent("staff_pin.locked"),
    ];
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const conflictsBefore = await conflictCount();

    await deliver(events);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 3);
    for (const event of events)
      expect(await parkedRows(event.id), event.name).toHaveLength(0);
    // Invalid fixture payloads: refused by the access applier, one conflict
    // each (never an unclassified park or a stall).
    expect(await conflictCount()).toBe(conflictsBefore + 3);
  });

  it("an unknown aggregate is parked 'unclassified' with exactly one alarm; a redelivery adds nothing", async () => {
    const unknown = edgeEvent("zz_widget.created");
    const { event: moved, ledgerEntryId } = stockMoved();
    const batch = [unknown, moved];
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const notificationsBefore = await notificationCount();
    const since = new Date();

    await deliver(batch);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 2);
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
    expect(await parkedRows(unknown.id)).toEqual([
      {
        event_name: "zz_widget.created",
        aggregate_type: "zz_widget",
        parked_reason: "unclassified",
      },
    ]);

    // Exactly one alarm, to the outlet's supervisor, without the payload.
    expect(await notificationCount()).toBe(notificationsBefore + 1);
    const alarms = await notificationsSince(since);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.user_id).toBe(supervisorUserId);
    expect(
      alarms[0]!.outlet_id === null || alarms[0]!.outlet_id === outletA,
    ).toBe(true);
    expect(JSON.stringify(alarms[0])).not.toContain(PAYLOAD_MARKER);

    // Redelivery of the same batch: no new rows, no second alarm.
    const parkedBefore = await parkedCount();
    const conflictsBefore = await conflictCount();
    await deliver(batch);
    expect(await parkedCount()).toBe(parkedBefore);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
    expect(await conflictCount()).toBe(conflictsBefore);
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
  });
});

describe("legend-eadm B alarm failure does not fail the batch", () => {
  it("a notification that throws still lets the batch apply and the cursor advance", async () => {
    // The alarm's notification insert is made to fail at the database for this
    // tenant only (both notification tables, so the test does not depend on
    // which module sends the alarm).
    await owner.query(
      `CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'alarm failure (test)'; END $$`,
    );
    for (const table of ["notification_outbox", "notifications"])
      await owner.query(
        `CREATE TRIGGER ${TRIGGER_FN}_t BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.tenant_id = '${tenantId}'::uuid) EXECUTE FUNCTION ${TRIGGER_FN}()`,
      );
    try {
      const unknown = edgeEvent("zz_failing.created");
      const { event: moved, ledgerEntryId } = stockMoved();
      const link = store();
      const cursorBefore = await link.lastReceivedInbound();
      const notificationsBefore = await notificationCount();

      await deliver([unknown, moved]); // must not reject

      expect(await link.lastReceivedInbound()).toBe(cursorBefore + 2);
      expect(await ledgerRows(ledgerEntryId)).toBe(1); // the later event applied
      expect((await parkedRows(unknown.id))[0]).toMatchObject({
        parked_reason: "unclassified", // the durable evidence stays
      });
      expect(await notificationCount()).toBe(notificationsBefore); // alarm lost, nothing half-written
    } finally {
      for (const table of ["notification_outbox", "notifications"])
        await owner.query(`DROP TRIGGER IF EXISTS ${TRIGGER_FN}_t ON ${table}`);
      await owner.query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
    }

    // The lost alarm does not silence the name: the next event alarms.
    const notificationsBefore = await notificationCount();
    await deliver([edgeEvent("zz_failing.created")]);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
  });
});

describe("legend-niq9 C stock.* other than stock.moved alarms once", () => {
  it("stock.adjusted ends up unclassified with exactly one alarm, and a redelivery adds none", async () => {
    const adjusted = edgeEvent("stock.adjusted");
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const notificationsBefore = await notificationCount();
    const since = new Date();

    await deliver([adjusted]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 1);
    expect(await parkedRows(adjusted.id)).toEqual([
      {
        event_name: "stock.adjusted",
        aggregate_type: "stock",
        parked_reason: "unclassified",
      },
    ]);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
    const alarms = await notificationsSince(since);
    expect(alarms.map((row) => row.user_id)).toEqual([supervisorUserId]);
    expect(JSON.stringify(alarms[0])).not.toContain(PAYLOAD_MARKER);

    await deliver([adjusted]); // redelivery
    expect(await parkedRows(adjusted.id)).toHaveLength(1);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
  });
});

describe("legend-eadm D alarm storm and once-only path", () => {
  it("legend-tbl4 indexes the tenant, event, outlet and alarm time used by the dedupe window", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'notification_outbox'
          AND indexname = 'notification_outbox_alarm_window_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain(
      "(tenant_id, event_type, outlet_id, created_at)",
    );
  });

  it("legend-tbl4 an outlet without a supervisor leaves no dedupe marker and alarms when one is assigned", async () => {
    const name = "zz_no_supervisor.created";
    const notificationsBefore = await notificationCount();
    const outboxCount = () =>
      count(
        `SELECT count(*)::int AS n FROM notification_outbox
          WHERE tenant_id = $1 AND event_type = 'edge_event.parked_unclassified'
            AND payload->>'eventName' = $2`,
        [tenantId, name],
      );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3",
      [tenantId, supervisorUserId, supervisorRoleId],
    );
    try {
      const unknown = edgeEvent(name);
      await deliver([unknown]);
      expect(await parkedRows(unknown.id)).toHaveLength(1);
      expect(await notificationCount()).toBe(notificationsBefore);
      expect(await outboxCount()).toBe(0);
    } finally {
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
        [tenantId, supervisorUserId, supervisorRoleId, outletA],
      );
    }
    await deliver([edgeEvent(name)]);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
    expect(await outboxCount()).toBe(1);
    await deliver([edgeEvent(name)]);
    expect(await notificationCount()).toBe(notificationsBefore + 1);
    expect(await outboxCount()).toBe(1);
  });

  it("legend-1opho records an alarm even if another aggregate cannot be enqueued", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const first = edgeEvent("order.paid", "order");
    const later = {
      ...edgeEvent("order.paid", "order"),
      aggregateId: first.aggregateId,
      sequence: 2,
    };
    const ready = edgeEvent("order.paid", "order");
    const firstId = createUlid();
    const readyId = createUlid();
    for (const [id, event] of [
      [firstId, first],
      [createUlid(), later],
      [readyId, ready],
    ] as const) {
      await withTenant(db, context, (tx) =>
        appendOutbox(tx, context, {
          id,
          event,
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        }),
      );
    }
    expect(
      await markOutboxDead(db, context, { outboxId: firstId, generation: 0 }),
    ).toBe(true);
    const before = await notificationCount();
    await expect(
      relayOutbox(
        db,
        context,
        async () => {
          throw new Error("enqueue failed");
        },
        undefined,
        { destinations: ["cloud-sync"] },
      ),
    ).rejects.toThrow("enqueue failed");
    expect(await notificationCount()).toBe(before + 1);
    await markOutboxDead(db, context, { outboxId: readyId, generation: 0 });
  });

  it("legend-1opho alarms again when a later event of the same aggregate is dead-lettered", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const first = edgeEvent("order.paid", "order");
    const second = {
      ...edgeEvent("order.paid", "order"),
      aggregateId: first.aggregateId,
      sequence: 2,
    };
    const third = {
      ...edgeEvent("order.paid", "order"),
      aggregateId: first.aggregateId,
      sequence: 3,
    };
    const firstId = createUlid();
    const secondId = createUlid();
    for (const [id, event] of [
      [firstId, first],
      [secondId, second],
      [createUlid(), third],
    ] as const) {
      await withTenant(db, context, (tx) =>
        appendOutbox(tx, context, {
          id,
          event,
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        }),
      );
    }
    const before = await notificationCount();
    await markOutboxDead(db, context, { outboxId: firstId, generation: 0 });
    await relayOutbox(db, context, async () => randomUUID(), undefined, {
      destinations: ["cloud-sync"],
    });
    expect(await notificationCount()).toBe(before + 1);
    await replayOutbox(db, context, {
      outboxId: firstId,
      actor: { type: "user", id: randomUUID() },
      reason: "Operator resolved the incident",
      authorize: async () => true,
    });
    await consumeOutbox(db, context, {
      outboxId: firstId,
      generation: 1,
      authorize: async () => true,
      deliver: async () => {},
    });
    await markOutboxDead(db, context, { outboxId: secondId, generation: 0 });
    await relayOutbox(db, context, async () => randomUUID(), undefined, {
      destinations: ["cloud-sync"],
    });
    await relayOutbox(db, context, async () => randomUUID(), undefined, {
      destinations: ["cloud-sync"],
    });
    expect(await notificationCount()).toBe(before + 2);
  });

  it("legend-1opho retries a failed alarm without blocking other aggregates", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const blocked = [
      edgeEvent("order.paid", "order"),
      edgeEvent("order.paid", "order"),
    ];
    for (const first of blocked) {
      const firstId = createUlid();
      const second = {
        ...edgeEvent("order.paid", "order"),
        aggregateId: first.aggregateId,
        sequence: 2,
      };
      for (const [id, event] of [
        [firstId, first],
        [createUlid(), second],
      ] as const) {
        await withTenant(db, context, (tx) =>
          appendOutbox(tx, context, {
            id,
            event,
            destination: "cloud-sync",
            direction: null,
            peerId: null,
          }),
        );
      }
      expect(
        await markOutboxDead(db, context, { outboxId: firstId, generation: 0 }),
      ).toBe(true);
    }
    const failedAggregate = ulidToUuid(blocked[0]!.aggregateId);
    const failureFn = `${TRIGGER_FN}_dead`;
    await owner.query(
      `CREATE FUNCTION ${failureFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'alarm failure (test)'; END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${failureFn}_t BEFORE INSERT ON notification_outbox FOR EACH ROW WHEN (NEW.tenant_id = '${tenantId}'::uuid AND NEW.event_type = 'edge_outbox.blocked' AND NEW.payload->>'aggregateId' = '${failedAggregate}') EXECUTE FUNCTION ${failureFn}()`,
    );
    const before = await notificationCount();
    try {
      await relayOutbox(db, context, async () => randomUUID(), undefined, {
        destinations: ["cloud-sync"],
      });
      expect(await notificationCount()).toBe(before + 1);
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS ${failureFn}_t ON notification_outbox`,
      );
      await owner.query(`DROP FUNCTION IF EXISTS ${failureFn}()`);
    }
    await relayOutbox(db, context, async () => randomUUID(), undefined, {
      destinations: ["cloud-sync"],
    });
    expect(await notificationCount()).toBe(before + 2);
    await relayOutbox(db, context, async () => randomUUID(), undefined, {
      destinations: ["cloud-sync"],
    });
    expect(await notificationCount()).toBe(before + 2);
  });

  it("legend-mciif skips supervisor lookup on repeated sweeps", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const destination = "test-mciif-dedupe";
    await createBlockedHead(context, destination);
    const notify = vi.spyOn(conflictAlerts, "notifyOutletSupervisors");
    try {
      await alertBlockedOutboxAggregates(db, context, {
        destinations: [destination],
      });
      await alertBlockedOutboxAggregates(db, context, {
        destinations: [destination],
      });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      notify.mockRestore();
    }
  });

  it("legend-mciif bounds a sweep and processes remaining heads on the next sweep", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const destination = "test-mciif-limit";
    for (let i = 0; i < 101; i++) await createBlockedHead(context, destination);
    const before = await notificationCount();
    await alertBlockedOutboxAggregates(db, context, {
      destinations: [destination],
    });
    const first = (await notificationCount()) - before;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(100);
    await alertBlockedOutboxAggregates(db, context, {
      destinations: [destination],
    });
    expect(await notificationCount()).toBeGreaterThan(before + first);
  }, 120_000);

  it("legend-mciif advances past a batch of failed alarms and retries it after wrapping", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const destination = "test-mciif-failed-batch";
    for (let i = 0; i < 101; i++) await createBlockedHead(context, destination);
    const before = await notificationCount();
    const notify = vi
      .spyOn(conflictAlerts, "notifyOutletSupervisors")
      .mockRejectedValue(new Error("notification unavailable"));
    try {
      await alertBlockedOutboxAggregates(db, context, {
        destinations: [destination],
      });
      expect(notify).toHaveBeenCalledTimes(100);
      expect(await notificationCount()).toBe(before);
    } finally {
      notify.mockRestore();
    }
    await alertBlockedOutboxAggregates(db, context, {
      destinations: [destination],
    });
    expect(await notificationCount()).toBe(before + 1);
    await alertBlockedOutboxAggregates(db, context, {
      destinations: [destination],
    });
    expect(await notificationCount()).toBe(before + 101);
  }, 120_000);

  it("legend-mciif logs missing recipients once across sweeps", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const destination = "test-mciif-empty";
    await createBlockedHead(context, destination);
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, supervisorUserId],
    );
    const errors = vi.spyOn(logger, "error");
    try {
      await alertBlockedOutboxAggregates(db, context, {
        destinations: [destination],
      });
      await alertBlockedOutboxAggregates(db, context, {
        destinations: [destination],
      });
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by) VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
        [tenantId, supervisorUserId, supervisorRoleId, outletA],
      );
    }
  });

  it("legend-1opho alarms once when a dead edge event blocks its aggregate across relay sweeps", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "domain" }),
      { kind: "tenant" },
    );
    const options = { destinations: ["cloud-sync"] };
    const blockedBefore = await countBlockedOutboxAggregates(
      db,
      context,
      options,
    );
    const first = edgeEvent("order.paid", "order");
    const second = {
      ...edgeEvent("order.paid", "order"),
      aggregateId: first.aggregateId,
      sequence: 2,
    };
    const firstId = createUlid();
    const secondId = createUlid();
    for (const [id, event] of [
      [firstId, first],
      [secondId, second],
    ] as const) {
      await withTenant(db, context, (tx) =>
        appendOutbox(tx, context, {
          id,
          event,
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        }),
      );
    }
    const before = await notificationCount();
    expect(
      await markOutboxDead(db, context, { outboxId: firstId, generation: 0 }),
    ).toBe(true);
    const sent: string[] = [];
    for (let sweep = 0; sweep < 3; sweep++) {
      await relayOutbox(
        db,
        context,
        async (job) => {
          sent.push(job.outboxId);
          return randomUUID();
        },
        undefined,
        { destinations: ["cloud-sync"] },
      );
    }
    expect(sent).not.toContain(secondId);
    expect(await notificationCount()).toBe(before + 1);
    expect(await countBlockedOutboxAggregates(db, context, options)).toBe(
      blockedBefore + 1,
    );
    const rows = await owner.query<{ dispatch_state: string }>(
      "SELECT dispatch_state FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2",
      [tenantId, ulidToUuid(firstId)],
    );
    expect(rows.rows[0]?.dispatch_state).toBe("dead");

    // A different aggregate is a distinct incident, but repeated sweeps of
    // either incident must not generate more alerts.
    const other = edgeEvent("order.paid", "order");
    const later = {
      ...edgeEvent("order.paid", "order"),
      aggregateId: other.aggregateId,
      sequence: 2,
    };
    const otherId = createUlid();
    for (const [id, event] of [
      [otherId, other],
      [createUlid(), later],
    ] as const) {
      await withTenant(db, context, (tx) =>
        appendOutbox(tx, context, {
          id,
          event,
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        }),
      );
    }
    expect(
      await markOutboxDead(db, context, { outboxId: otherId, generation: 0 }),
    ).toBe(true);
    for (let sweep = 0; sweep < 2; sweep++) {
      await relayOutbox(
        db,
        context,
        async () => randomUUID(),
        undefined,
        options,
      );
    }
    expect(await notificationCount()).toBe(before + 2);
    expect(await countBlockedOutboxAggregates(db, context, options)).toBe(
      blockedBefore + 2,
    );

    const anotherTenant = establishScopedTenantContext(
      establishTenantContext({
        tenantId: randomUUID(),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    expect(await countBlockedOutboxAggregates(db, anotherTenant, options)).toBe(
      0,
    );
  });

  it("unknown events of one name send one alarm; a second name sends one more", async () => {
    const storm = [
      edgeEvent("zz_storm.created"),
      edgeEvent("zz_storm.created"),
      edgeEvent("zz_storm.created"),
    ];
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const notificationsBefore = await notificationCount();

    await deliver(storm);
    await deliver([edgeEvent("zz_storm.created")]); // a later batch, same name

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 4);
    for (const event of storm)
      expect((await parkedRows(event.id))[0]!.parked_reason).toBe(
        "unclassified",
      );
    expect(await notificationCount()).toBe(notificationsBefore + 1);

    await deliver([edgeEvent("zz_storm.updated")]);
    expect(await notificationCount()).toBe(notificationsBefore + 2);

    // Steady traffic does not silence the name forever: once the last alarm
    // is older than 24 hours, the next event alarms again.
    await owner.query(
      `UPDATE notification_outbox SET created_at = created_at - interval '25 hours'
        WHERE tenant_id = $1 AND event_type = 'edge_event.parked_unclassified'
          AND payload->>'eventName' = 'zz_storm.created'`,
      [tenantId],
    );
    await deliver([edgeEvent("zz_storm.created")]);
    expect(await notificationCount()).toBe(notificationsBefore + 3);
  });

  it("an event whose parked row already exists sends no alarm", async () => {
    // The applier runs (edge_received_events has no row), but the park insert
    // conflicts, so the once-only guard skips the alarm. The name is new, so
    // the per-name dedupe cannot be what silences it.
    const unknown = edgeEvent("zz_preparked.created");
    await owner.query(
      `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, 1, $7, 'unclassified', $8::jsonb)`,
      [
        tenantId,
        outletA,
        node.scope.edgeNodeId,
        ulidToUuid(unknown.id),
        unknown.aggregateType,
        unknown.aggregateId,
        unknown.name,
        JSON.stringify(unknown),
      ],
    );
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();
    const notificationsBefore = await notificationCount();

    await deliver([unknown]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 1);
    expect(await parkedRows(unknown.id)).toHaveLength(1);
    expect(await notificationCount()).toBe(notificationsBefore);
  });
});
