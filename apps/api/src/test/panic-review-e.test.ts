// Review round 2, card G2 (legend-bod, docs/briefs/bod-emergency-impl.md): the
// edge applies `panic_alert.resolved` (cloud -> edge) and closes its copy of
// the alert.
//  - `resolved_*` is set once; `acknowledged_*` is filled when empty (ack device
//    null) and never overwritten; a replay or a later event changes nothing;
//  - the edge already holds sequence 1 of the same alert in its own queue
//    (edge_to_cloud), so the link must still accept the cloud's sequence 1;
//  - an alert the edge does not know is a no-op (no conflict row);
//  - effect: no resend, no POS fallback, nothing for a socket that connects later.
// How the edge is simulated: as panic-sync.test.ts (one database, the real
// press route, the real link store). The socket is a fake hub subscriber; its
// receiver-session re-check is mocked (the session needs no staff fixtures).
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Must run before ../config/env is first imported (imports are hoisted).
const edgeDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "panic-review-e-"));
  process.env.EDGE_SELFIE_DIR = dir;
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000021.5d1e7c00-0000-4000-8000-000000000022.5d1e7c00-0000-4000-8000-000000000023." +
    "A".repeat(43);
  return dir;
});

const sessionCheck = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../services/panic-receiver-session.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/panic-receiver-session.ts")
  >()),
  recheckReceiverSession: sessionCheck,
}));

import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PANIC_ALERT_AGGREGATE_TYPE,
  panicAlertResolvedEvent,
  type PanicServerFrame,
} from "@starter/shared/facility";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import {
  registerEdgeEventHandler,
  resetEdgeApplierRegistryForTests,
} from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { subscribe, type HubSubscriber } from "../edge/panic-relay-hub.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  acknowledgePanicAlert,
  resendDue,
  sendOpenAlertsTo,
} from "../services/panic-relay.service.ts";
import { setEdgeNodeForEnvTests, withEdgeModeEnv } from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent } from "./helpers.ts";
import {
  PANIC_FALLBACK_ROUTE,
  PANIC_ROUTES,
  pressBody,
} from "./panic-test-helpers.ts";

const edge = createApp({ edgeMode: true });
delete process.env.EDGE_MODE;

const T = 60_000;
const actor = randomUUID();
const resolver = randomUUID();

let tenant: IsolatedTenant;
let outletId: string;
let node: AuthenticatedEdgeNode;
let posDevice: { id: string; token: string };

const scope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A real press on the edge: returns the alert id (read from the press link). */
async function pressAlert(): Promise<string> {
  const enrolled = await enrollDevice(scope(), actor, {
    outletId,
    type: "panic_button",
    label: `Tombol ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  const eventId = `evt-${randomUUID()}`;
  const response = await withEdgeModeEnv(() =>
    agent(edge)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, enrolled.token)
      .send(pressBody(eventId)),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const { rows } = await owner.query<{ alert_id: string }>(
    `SELECT alert_id::text AS alert_id FROM panic_press_events
      WHERE tenant_id = $1 AND device_id = $2 AND device_event_id = $3`,
    [tenant.tenantId, enrolled.device.id, eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.alert_id;
}

type AlertRow = {
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  ack_device_id: string | null;
};

async function alertState(alertId: string): Promise<AlertRow | undefined> {
  const { rows } = await owner.query<AlertRow>(
    `SELECT resolved_at, resolved_by, resolution_note, acknowledged_at, acknowledged_by,
            ack_device_id::text AS ack_device_id
       FROM panic_alerts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, alertId],
  );
  return rows[0];
}

function resolvedEnvelope(
  alertId: string,
  sequence: number,
  payload: { resolvedAt?: string; note?: string | null } = {},
): EventEnvelope {
  const now = new Date();
  return panicAlertResolvedEvent.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: tenant.tenantId,
    outletId,
    name: panicAlertResolvedEvent.name,
    version: panicAlertResolvedEvent.version,
    aggregateType: PANIC_ALERT_AGGREGATE_TYPE,
    aggregateId: alertId,
    sequence,
    occurredAt: now.toISOString(),
    actor: { type: "user", id: resolver },
    deviceId: null,
    idempotencyKey: `${PANIC_ALERT_AGGREGATE_TYPE}:${alertId}:cloud:${sequence}:${randomBytes(3).toString("hex")}`,
    payloadSchemaRef: panicAlertResolvedEvent.payloadSchemaRef,
    payload: {
      alertId,
      resolvedBy: resolver,
      resolvedAt: payload.resolvedAt ?? now.toISOString(),
      resolutionNote: payload.note === undefined ? "Aman" : payload.note,
    },
  }) as EventEnvelope;
}

/** One link batch from the cloud, through the real edge receive path. */
async function deliver(events: EventEnvelope[]) {
  registerPanicAlertEdgeApplier();
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
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

async function conflictReasons(alertId: string): Promise<string[]> {
  const { rows } = await owner.query<{ reason: string }>(
    `SELECT reason FROM edge_sync_conflicts
      WHERE tenant_id = $1 AND aggregate_type = 'panic_alert' AND aggregate_id = $2
      ORDER BY created_at`,
    [tenant.tenantId, alertId],
  );
  return rows.map((row) => row.reason);
}

/** A fake staff socket of the outlet; the frames it was sent are in `sent`. */
function fakeSocket() {
  const sent: PanicServerFrame[] = [];
  const subscriber: HubSubscriber = {
    session: {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      outletId,
      deviceId: posDevice.id,
      userId: randomUUID(),
      pinGenerationAt: new Date(),
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    close: () => undefined,
    alerts: new Map(),
  };
  const unsubscribe = subscribe(subscriber);
  cleanups.push(unsubscribe);
  const sentFor = (alertId: string) =>
    sent.filter((frame) => frame.alertId === alertId).length;
  return { subscriber, sentFor, sent };
}

const cleanups: Array<() => void> = [];
// The service timestamps sends with the real clock. Advance beyond that clock
// too, so slow setup or database calls cannot leave a tick before the last send.
// Every tick is also 4 s later than the previous one, making refresh due again.
let clock = Date.now();
const tick = () => {
  clock = Math.max(clock, Date.now()) + 4_000;
  return resendDue(clock);
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `prev-e-${randomBytes(3).toString("hex")}`,
  );
  outletId = tenant.outletId;
  setEdgeNodeForEnvTests({ tenantId: tenant.tenantId, outletId: outletId });
  const registered = await registerEdgeNode(scope(), actor, {
    outletId,
    role: "primary",
    label: "Edge darurat resolve",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
  const enrolled = await enrollDevice(scope(), actor, {
    outletId,
    type: "pos",
    label: `Layar darurat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  posDevice = { id: enrolled.device.id, token: enrolled.token };
}, 120_000);

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

afterAll(async () => {
  setEdgeNodeForEnvTests(null);
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  rmSync(edgeDir, { recursive: true, force: true });
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
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenant.tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("G2 the edge applies panic_alert.resolved", () => {
  it(
    "closes the alert: resolved_* set, acknowledged_* filled with no ack device",
    async () => {
      const alertId = await pressAlert();
      const before = await alertState(alertId);
      expect(before?.resolved_at).toBeNull();
      expect(before?.acknowledged_at).toBeNull();

      // The edge holds its own sequence 1 (raised, edge_to_cloud): the cloud's
      // first resolved is sequence 1 of another direction and must still apply.
      const resolvedAt = new Date(Date.now() + 1_000).toISOString();
      await deliver([
        resolvedEnvelope(alertId, 1, { resolvedAt, note: "Aman" }),
      ]);

      const after = await alertState(alertId);
      expect(after?.resolved_by).toBe(resolver);
      expect(after?.resolved_at?.toISOString()).toBe(resolvedAt);
      expect(after?.resolution_note).toBe("Aman");
      expect(after?.acknowledged_by).toBe(resolver);
      expect(after?.acknowledged_at?.toISOString()).toBe(resolvedAt);
      expect(after?.ack_device_id).toBeNull();
      expect(await conflictReasons(alertId)).toEqual([]);
    },
    T,
  );

  it(
    "does not overwrite an acknowledgement that exists",
    async () => {
      const alertId = await pressAlert();
      const ackedAt = new Date(Date.now() - 5_000);
      await asTenant((client) =>
        client.query(
          `UPDATE panic_alerts SET acknowledged_at = $3, acknowledged_by = 'staff-first', ack_device_id = $4
            WHERE tenant_id = $1 AND id = $2`,
          [tenant.tenantId, alertId, ackedAt, posDevice.id],
        ),
      );
      await deliver([resolvedEnvelope(alertId, 1)]);
      const after = await alertState(alertId);
      expect(after?.resolved_by).toBe(resolver);
      expect(after?.acknowledged_by).toBe("staff-first");
      expect(after?.acknowledged_at?.getTime()).toBe(ackedAt.getTime());
      expect(after?.ack_device_id).toBe(posDevice.id);
    },
    T,
  );

  it(
    "a replay or a later resolved event changes nothing",
    async () => {
      const alertId = await pressAlert();
      const first = resolvedEnvelope(alertId, 1, { note: "Pertama" });
      await deliver([first]);
      const applied = await alertState(alertId);
      await deliver([first]);
      await deliver([
        resolvedEnvelope(alertId, 2, {
          resolvedAt: new Date(Date.now() + 60_000).toISOString(),
          note: "Kedua",
        }),
      ]);
      expect(await alertState(alertId)).toEqual(applied);
      expect(applied?.resolution_note).toBe("Pertama");
    },
    T,
  );

  it(
    "an alert the edge does not know is a no-op: no conflict row, the event is applied",
    async () => {
      const unknown = randomUUID();
      // The id is not checked against a press here: the handler only looks it up.
      await deliver([resolvedEnvelope(unknown, 1)]);
      expect(await alertState(unknown)).toBeUndefined();
      expect(await conflictReasons(unknown)).toEqual([]);
    },
    T,
  );

  it(
    "boot is idempotent and the cloud_to_edge handler is taken",
    async () => {
      registerPanicAlertEdgeApplier();
      // Registering the same handler again must not throw (idempotent boot);
      // a second, different handler for the event is a wiring bug.
      registerPanicAlertEdgeApplier();
      expect(() =>
        registerEdgeEventHandler(
          "cloud_to_edge",
          panicAlertResolvedEvent.name,
          async () => undefined,
        ),
      ).toThrow(/already registered/);
    },
    T,
  );
});

describe("G2 effects of a resolved alert on the edge", () => {
  it(
    "legend-5egl3 recovery does not send a stale panic after acknowledgement",
    async () => {
      const alertId = await pressAlert();
      const socket = fakeSocket();
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sessionCheck.mockImplementationOnce(async () => {
        entered();
        await gate;
        return { ok: true };
      });
      const recovery = sendOpenAlertsTo(socket.subscriber);
      await Promise.race([
        waiting,
        recovery.then(() => {
          throw new Error("Recovery finished before the session check");
        }),
      ]);
      try {
        await acknowledgePanicAlert(socket.subscriber.session, alertId);
      } finally {
        release();
      }
      await recovery;
      expect(
        socket.sent.filter(
          (frame) => frame.type === "panic" && frame.alertId === alertId,
        ),
      ).toHaveLength(0);
      expect(socket.subscriber.alerts.has(alertId)).toBe(false);
    },
    T,
  );

  it(
    "the resend stops and a socket that connects later never gets the alert",
    async () => {
      // Reproduce a slow full-suite startup without sleeping: the simulated
      // clock can predate the real send, which records its own Date.now().
      clock = Date.now() - 60_000;
      const alertId = await pressAlert();
      const open = fakeSocket();
      await sendOpenAlertsTo(open.subscriber);
      expect(open.sentFor(alertId)).toBe(1);
      // Baseline: an open, unconfirmed alert is sent again.
      await tick();
      expect(open.sentFor(alertId)).toBe(2);

      await deliver([resolvedEnvelope(alertId, 1)]);

      // The open-alert refresh (every 3 s) drops it; nothing is sent again.
      await tick();
      await tick();
      await tick();
      expect(open.sentFor(alertId)).toBe(2);
      expect(open.subscriber.alerts.has(alertId)).toBe(false);

      const late = fakeSocket();
      await sendOpenAlertsTo(late.subscriber);
      expect(late.sentFor(alertId)).toBe(0);
    },
    T,
  );

  it(
    "the POS fallback no longer lists the alert",
    async () => {
      const alertId = await pressAlert();
      // Shown to a POS already (the fallback rule: shown, or 15 s without receipt).
      await asTenant((client) =>
        client.query(
          "UPDATE panic_alerts SET fallback_shown_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, alertId],
        ),
      );
      const read = async () => {
        const response = await withEdgeModeEnv(() =>
          agent(edge)
            .get(PANIC_FALLBACK_ROUTE)
            .set(DEVICE_TOKEN_HEADER, posDevice.token),
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (response.body.data.alerts as Array<{ alertId: string }>).map(
          (item) => item.alertId,
        );
      };
      expect(await read()).toContain(alertId);
      await deliver([resolvedEnvelope(alertId, 1)]);
      expect(await read()).not.toContain(alertId);
    },
    T,
  );
});
