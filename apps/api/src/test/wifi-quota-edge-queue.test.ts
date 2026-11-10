// legend-oeqme: Wi-Fi quota edge apply queue. The edge no longer calls the Wi-Fi
// agent inside the link receive transaction: `wifi_quota.updated` is validated,
// inserted into `wifi_quota_apply_queue` (same tx) and the receive always
// succeeds. `drainWifiQuotaQueue` (edge/wifi-quota-queue-worker.ts) applies the
// rows later, one pass per call.
//
// Written from the brief, not from the implementation. Assumptions:
// - The worker is imported dynamically so a missing module fails each test on
//   its own instead of the whole file.
// - A freshly received row is due at once. To keep the tests independent of the
//   real wall clock (the worker runs on the fixed clock NOW) the helper `drain`
//   sets next_attempt_at of never-tried rows (attempts = 0) to just before NOW.
//   Rows that were tried keep the next_attempt_at the worker wrote.
// - The returned counters for `refused` are not asserted (the brief lists no
//   `refused` counter); the row status and the conflict row are.
// - "Standby / other node context sees no rows" is expressed with a node of the
//   same tenant at outlet B and with a node of another tenant. A standby node of
//   the same outlet would legitimately share the outlet's rows, so it is not used.
// - The "order-like later event" of the stalled-link bug uses a wifi event of a
//   second session; the qr-order applier is not exercised here.
// - Event sequences grow monotonically inside each test (the receiver rule of
//   master_data drops an older or equal aggregate sequence).
// - A `detail` of edge_sync_conflicts is compared as text (jsonb or text).
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerWifiQuotaEdgeApplier } from "../edge/wifi-quota-applier.ts";
import {
  installWifiEnforcement,
  type WifiEnforcement,
} from "../edge/wifi/port.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { deliverWifiQuotaEvent } from "../services/wifi-quota-consumer.ts";
import {
  asTenant,
  createWorld,
  hex64,
  orderPaidEvent,
  owner,
  seedMember,
  seedOrder,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerWifiQuotaEdgeApplier();
});

afterEach(() => {
  installWifiEnforcement(null);
  resetEdgeApplierRegistryForTests();
});

const NOW = new Date("2026-11-10T07:30:00Z");
const TODAY = "2026-11-10";
/** End of business day 2026-11-10 (04:00 Jakarta on the 11th). */
const DAY_END = "2026-11-10T21:00:00.000Z";
const MAC = "aa:bb:cc:dd:ee:ff";
const MAC2 = "11:22:33:44:55:66";
const plus = (ms: number) => new Date(NOW.getTime() + ms);

const scopeFor = (world: World, outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

// ---- fixtures (copied from wifi-quota-edge-apply.test.ts) -----------------------

type Scenario = {
  world: World;
  zoneId: string;
  policyId: string;
  profileId: string;
  sessionId: string;
  node: AuthenticatedEdgeNode;
};

async function registerNode(
  world: World,
  outletId: string,
): Promise<AuthenticatedEdgeNode> {
  const registered = await registerEdgeNode(
    scopeFor(world, [outletId]),
    randomUUID(),
    { outletId, role: "primary", label: "Utama Wifi" },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

async function insertGrant(
  tenantId: string,
  outletId: string,
  sessionId: string,
  mac: string,
  status = "active",
) {
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO wifi_device_grants
         (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
          speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
          renew_until, requested_at, authorized_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, $7,
               now() + interval '8 hours', now(), now(), now() + interval '65 minutes')`,
      [randomUUID(), tenantId, outletId, sessionId, hex64(), mac, status],
    );
  });
}

/** Tenant with a Wi-Fi policy, a member, an open session and a node at outlet A. */
async function scenario(options: { grant?: boolean } = {}): Promise<Scenario> {
  const world = await createWorld();
  const zoneId = randomUUID();
  const policyId = randomUUID();
  const sessionId = randomUUID();
  const member = await seedMember(world.tenantId);
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, 'Zona Wifi', 'pay_first', '[]')`,
      [zoneId, world.tenantId, world.outletA],
    );
    await client.query(
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes,
          spend_per_extra_hour_idr, extra_minutes, max_devices, peak_schedule,
          base_speed_kbps, full_speed_kbps, tier_bonus_minutes, spend_mode)
       VALUES ($1, $2, $3, $4, 120, 60, 30000, 60, 2, $5, 2000, 20000, $6, NULL)`,
      [
        policyId,
        world.tenantId,
        world.outletA,
        zoneId,
        JSON.stringify([
          { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
          { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "18:00", endsAt: "21:00" },
          { daysOfWeek: [0, 6], startsAt: "00:00", endsAt: "24:00" },
        ]),
        JSON.stringify({ gold: 60, platinum: 120 }),
      ],
    );
    await client.query(
      `INSERT INTO wifi_sessions
         (id, tenant_id, outlet_id, customer_profile_id, zone_id, policy_id,
          device_hash, business_date, quota_minutes, used_minutes, speed_tier,
          started_at, accrued_at, quota_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 120, 0, 'full', $9, $9, $9)`,
      [
        sessionId,
        world.tenantId,
        world.outletA,
        member.id,
        zoneId,
        policyId,
        hex64(),
        TODAY,
        NOW.toISOString(),
      ],
    );
  });
  if (options.grant !== false)
    await insertGrant(world.tenantId, world.outletA, sessionId, MAC);
  const node = await registerNode(world, world.outletA);
  return { world, zoneId, policyId, profileId: member.id, sessionId, node };
}

/** A second open session (own member, own device) with a live grant at outlet A. */
async function secondSession(s: Scenario): Promise<string> {
  const member = await seedMember(s.world.tenantId);
  const sessionId = randomUUID();
  await asTenant(s.world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO wifi_sessions
         (id, tenant_id, outlet_id, customer_profile_id, zone_id, policy_id,
          device_hash, business_date, quota_minutes, used_minutes, speed_tier,
          started_at, accrued_at, quota_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 120, 0, 'full', $9, $9, $9)`,
      [
        sessionId,
        s.world.tenantId,
        s.world.outletA,
        member.id,
        s.zoneId,
        s.policyId,
        hex64(),
        TODAY,
        NOW.toISOString(),
      ],
    );
  });
  await insertGrant(s.world.tenantId, s.world.outletA, sessionId, MAC2);
  return sessionId;
}

/** A paid order of the member: adds an hour of quota (Rp45.000). */
async function pay(s: Scenario, cash = 45_000) {
  const orderUlid = await seedOrder(s.world.tenantId, {
    outletId: s.world.outletA,
    profileId: s.profileId,
    grossSalesIdr: cash,
    businessDate: TODAY,
    status: "completed",
  });
  const base = orderPaidEvent(s.world, {
    orderUlid,
    outletId: s.world.outletA,
    grossSalesIdr: cash,
    businessDate: TODAY,
    paidAt: NOW.toISOString(),
    paidPointsIdr: 0,
  });
  const event = {
    ...base,
    payload: {
      ...base.payload,
      paidCashIdr: cash,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
    },
  } as EventEnvelope;
  await withTenant(db, s.world.context, (tx) =>
    deliverWifiQuotaEvent(s.world.context, event, tx, NOW),
  );
}

async function firstEvent(s: Scenario): Promise<EventEnvelope> {
  await pay(s);
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM edge_outbound_queue
      WHERE tenant_id = $1 AND event->>'name' = 'wifi_quota.updated'
      ORDER BY link_seq`,
    [s.world.tenantId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** A copy of a queued event with its own id, sequence and payload overrides. */
function variant(
  event: EventEnvelope,
  sequence: number,
  payload: Record<string, unknown> = {},
): EventEnvelope {
  // When the aggregate is the session itself, a copy for another session moves
  // to that session's aggregate (its sequence then restarts per aggregate, but
  // the tests keep sequences growing, which is valid there too).
  const sessionId = (event.payload as { sessionId?: string }).sessionId;
  const target = payload.sessionId as string | undefined;
  const aggregateId =
    target && event.aggregateId === sessionId ? target : event.aggregateId;
  return {
    ...event,
    aggregateId,
    id: createUlid() as EventEnvelope["id"],
    sequence,
    idempotencyKey: `wq-${randomUUID()}`,
    payload: { ...(event.payload as Record<string, unknown>), ...payload },
  } as EventEnvelope;
}

// ---- edge side -------------------------------------------------------------------

type Call = (context: unknown, input: unknown) => Promise<undefined>;

function agentWith(impl: Call = async () => undefined) {
  const applySession = vi.fn<Call>(impl);
  const endSession = vi.fn<Call>(async () => undefined);
  installWifiEnforcement({
    applySession,
    endSession,
  } as unknown as WifiEnforcement);
  return { applySession, endSession };
}

const failWith = (error: unknown) =>
  agentWith(async () => {
    throw error;
  });

function edgeStore(node: AuthenticatedEdgeNode) {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
  });
}

/** One link batch from the cloud, through the real receive path. */
async function deliver(node: AuthenticatedEdgeNode, events: EventEnvelope[]) {
  const link = edgeStore(node);
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

const cursor = (node: AuthenticatedEdgeNode) =>
  edgeStore(node).lastReceivedInbound();

async function receipts(tenantId: string, eventId: string) {
  const { rows } = await owner.query<{ outcome: string }>(
    "SELECT outcome FROM edge_inbound_events WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
  return rows.map((row) => row.outcome);
}

type ConflictRow = { reason: string; direction: string; detail: string };

async function conflicts(tenantId: string, eventId: string) {
  const { rows } = await owner.query<ConflictRow>(
    `SELECT reason, direction, detail::text AS detail
       FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid`,
    [tenantId, ulidToUuid(eventId)],
  );
  return rows;
}

const calledWith = (
  s: Scenario,
  remainingSeconds: number,
  sessionId = s.sessionId,
  mac = MAC,
) => [
  expect.anything(),
  {
    outletId: s.world.outletA,
    wifiSessionId: sessionId,
    controllerDeviceId: mac,
    speedTier: "full",
    fullSpeedKbps: 20_000,
    baseSpeedKbps: 2_000,
    remainingSeconds,
    sessionEndsAt: DAY_END,
  },
];

// ---- queue table and worker ------------------------------------------------------

type QueueRow = {
  event_id: string;
  tenant_id: string;
  outlet_id: string;
  wifi_session_id: string;
  aggregate_sequence: string | number;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  last_attempt_at: Date | null;
  done_at: Date | null;
  event: unknown;
};

async function queue(tenantId: string): Promise<QueueRow[]> {
  const { rows } = await owner.query<QueueRow>(
    `SELECT event_id, tenant_id, outlet_id, wifi_session_id, aggregate_sequence,
            status, attempts, next_attempt_at, last_error, last_attempt_at,
            done_at, event
       FROM wifi_quota_apply_queue
      WHERE tenant_id = $1
      ORDER BY aggregate_sequence`,
    [tenantId],
  );
  return rows;
}

async function rowOf(tenantId: string, event: EventEnvelope) {
  const found = (await queue(tenantId)).filter(
    (row) => row.event_id === ulidToUuid(event.id),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

type DrainOptions = {
  now?: Date;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  shouldStop?: () => boolean;
};

async function drainRaw(
  node: AuthenticatedEdgeNode,
  options: DrainOptions = {},
) {
  const worker = await import("../edge/wifi-quota-queue-worker.ts");
  return worker.drainWifiQuotaQueue({
    context: node.context,
    now: NOW,
    ...options,
  });
}

/** Never-tried rows become due just before NOW, then one worker pass runs. */
async function makeDue(tenantId: string) {
  await owner.query(
    `UPDATE wifi_quota_apply_queue
        SET next_attempt_at = $2
      WHERE tenant_id = $1 AND status = 'pending' AND attempts = 0`,
    [tenantId, plus(-1000).toISOString()],
  );
}

async function drain(
  s: Scenario,
  options: DrainOptions = {},
  node: AuthenticatedEdgeNode = s.node,
) {
  await makeDue(s.world.tenantId);
  return drainRaw(node, options);
}

// ---- 1. receive never touches the agent -------------------------------------------

describe("legend-oeqme receive", () => {
  it("a 503 agent no longer stalls the link: the batch resolves, the cursor advances by 2, nothing is applied yet", async () => {
    const s = await scenario();
    const other = await secondSession(s);
    const event = await firstEvent(s);
    const first = variant(event, 2, { quotaMinutes: 240 });
    const second = variant(event, 3, { sessionId: other, quotaMinutes: 200 });
    const agent = failWith(
      new HttpError(503, "WIFI_AGENT_NOT_READY", "Agen belum siap."),
    );

    const before = await cursor(s.node);
    await expect(deliver(s.node, [first, second])).resolves.toBeUndefined();
    expect(await cursor(s.node)).toBe(before + 2);
    expect(agent.applySession).not.toHaveBeenCalled();
    expect(await receipts(s.world.tenantId, first.id)).toEqual(["applied"]);
    expect(await receipts(s.world.tenantId, second.id)).toEqual(["applied"]);
    expect(await conflicts(s.world.tenantId, first.id)).toEqual([]);
    expect(await conflicts(s.world.tenantId, second.id)).toEqual([]);
    expect((await queue(s.world.tenantId)).map((row) => row.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("stores the event in wifi_quota_apply_queue (pending, 0 attempts) and does not call the agent", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    expect(agent.applySession).not.toHaveBeenCalled();
    expect(agent.endSession).not.toHaveBeenCalled();
    expect(await receipts(s.world.tenantId, event.id)).toEqual(["applied"]);
    const row = await rowOf(s.world.tenantId, event);
    expect(row).toMatchObject({
      tenant_id: s.world.tenantId,
      outlet_id: s.world.outletA,
      wifi_session_id: s.sessionId,
      status: "pending",
      attempts: 0,
    });
    expect(Number(row.aggregate_sequence)).toBe(event.sequence);
    expect(row.event).toMatchObject({
      id: event.id,
      name: "wifi_quota.updated",
      payload: { sessionId: s.sessionId },
    });
    expect(row.done_at).toBeNull();
  });

  it("receive then drain applies once with the live grant's controller id", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    const result = await drain(s);
    expect(result).toMatchObject({
      applied: 1,
      retried: 0,
      failed: 0,
      superseded: 0,
      skipped: 0,
    });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(...calledWith(s, 180 * 60));
    expect(agent.endSession).not.toHaveBeenCalled();
    const row = await rowOf(s.world.tenantId, event);
    expect(row.status).toBe("applied");
    expect(row.done_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("an empty queue is a no-op pass", async () => {
    const s = await scenario();
    const agent = agentWith();
    const result = await drain(s);
    expect(result).toEqual({
      applied: 0,
      retried: 0,
      failed: 0,
      superseded: 0,
      skipped: 0,
    });
    expect(agent.applySession).not.toHaveBeenCalled();
  });
});

// ---- 2. skip / supersede rules ----------------------------------------------------

describe("legend-oeqme worker: skip and supersede", () => {
  it("a session without a live grant is skipped and the agent is not called", async () => {
    const s = await scenario({ grant: false });
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    const result = await drain(s);
    expect(result).toMatchObject({ skipped: 1, applied: 0, retried: 0 });
    expect(agent.applySession).not.toHaveBeenCalled();
    expect(agent.endSession).not.toHaveBeenCalled();
    expect((await rowOf(s.world.tenantId, event)).status).toBe("skipped");
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
  });

  it("a pending grant counts as live and is applied", async () => {
    const s = await scenario({ grant: false });
    await insertGrant(
      s.world.tenantId,
      s.world.outletA,
      s.sessionId,
      MAC,
      "pending",
    );
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    await drain(s);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.world.tenantId, event)).status).toBe("applied");
  });

  it("a session that already ended (sessionEndsAt <= now) is skipped", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    const result = await drain(s, {
      now: new Date(Date.parse(DAY_END) + 60_000),
    });
    expect(result).toMatchObject({ skipped: 1, applied: 0 });
    expect(agent.applySession).not.toHaveBeenCalled();
    expect((await rowOf(s.world.tenantId, event)).status).toBe("skipped");
  });

  it("only the newest pending row of a session is applied; the older one is superseded without an agent call", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const older = variant(event, 2, { quotaMinutes: 240 });
    const newest = variant(event, 3, { quotaMinutes: 300 });
    const agent = agentWith();
    await deliver(s.node, [older, newest]);

    const result = await drain(s);
    // The older row may be superseded at receive or in this pass; only the end state is spec'd.
    expect(result).toMatchObject({ applied: 1, retried: 0 });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(...calledWith(s, 300 * 60));
    expect((await rowOf(s.world.tenantId, older)).status).toBe("superseded");
    expect((await rowOf(s.world.tenantId, newest)).status).toBe("applied");
  });

  it("a row that is not due yet is not tried; it is applied once due", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);
    await owner.query(
      "UPDATE wifi_quota_apply_queue SET next_attempt_at = $2 WHERE tenant_id = $1",
      [s.world.tenantId, plus(3_600_000).toISOString()],
    );

    const early = await drainRaw(s.node);
    expect(early).toMatchObject({ applied: 0, retried: 0, failed: 0 });
    expect(agent.applySession).not.toHaveBeenCalled();
    const waiting = await rowOf(s.world.tenantId, event);
    expect(waiting).toMatchObject({ status: "pending", attempts: 0 });

    await drainRaw(s.node, { now: plus(2 * 3_600_000) });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.world.tenantId, event)).status).toBe("applied");
  });
});

// ---- 3. agent errors --------------------------------------------------------------

describe("legend-oeqme worker: transient agent errors keep the row pending", () => {
  it.each([
    [
      "503 WIFI_AGENT_NOT_READY",
      new HttpError(503, "WIFI_AGENT_NOT_READY", "x"),
      "WIFI_AGENT_NOT_READY",
    ],
    [
      "502 WIFI_CONTROLLER_ERROR",
      new HttpError(502, "WIFI_CONTROLLER_ERROR", "x"),
      "WIFI_CONTROLLER_ERROR",
    ],
    [
      "409 WIFI_GRANT_IN_FLIGHT",
      new HttpError(409, "WIFI_GRANT_IN_FLIGHT", "x"),
      "WIFI_GRANT_IN_FLIGHT",
    ],
    [
      "408 timeout",
      new HttpError(408, "REQUEST_TIMEOUT", "x"),
      "REQUEST_TIMEOUT",
    ],
    [
      "429 rate limited",
      new HttpError(429, "RATE_LIMITED", "x"),
      "RATE_LIMITED",
    ],
  ])(
    "%s: pending, attempts + 1, next_attempt_at = now + default backoff, last_error = code, no conflict",
    async (_label, error, code) => {
      const s = await scenario();
      const event = await firstEvent(s);
      const agent = failWith(error);
      await deliver(s.node, [event]);

      const result = await drain(s);
      expect(result).toMatchObject({ retried: 1, applied: 0, failed: 0 });
      expect(agent.applySession).toHaveBeenCalledTimes(1);
      const row = await rowOf(s.world.tenantId, event);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe(code);
      expect(row.next_attempt_at?.getTime()).toBe(plus(5000).getTime());
      expect(row.last_attempt_at).not.toBeNull();
      expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
    },
  );

  it("a non-HttpError (network failure) is retried and its message payload is not stored as last_error", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    failWith(new Error(`connect ECONNREFUSED session ${s.sessionId}`));
    await deliver(s.node, [event]);

    const result = await drain(s);
    expect(result).toMatchObject({ retried: 1, failed: 0 });
    const row = await rowOf(s.world.tenantId, event);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.last_error).toBeTruthy();
    expect(row.last_error).not.toContain(s.sessionId);
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
  });

  it("uses backoffMs(attempts so far) for the next attempt and waits until it is due", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const backoffMs = vi.fn((attempt: number) => attempt * 60_000);
    failWith(new HttpError(503, "WIFI_AGENT_NOT_READY", "x"));
    await deliver(s.node, [event]);

    await drain(s, { backoffMs });
    expect(backoffMs).toHaveBeenCalledWith(1);
    expect(
      (await rowOf(s.world.tenantId, event)).next_attempt_at?.getTime(),
    ).toBe(plus(60_000).getTime());

    // Not due at +30s: no second call. Due at +90s: the agent is back and applies.
    const agent = agentWith();
    await drainRaw(s.node, { now: plus(30_000), backoffMs });
    expect(agent.applySession).not.toHaveBeenCalled();
    expect((await rowOf(s.world.tenantId, event)).attempts).toBe(1);
    await drainRaw(s.node, { now: plus(90_000), backoffMs });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(...calledWith(s, 180 * 60));
    expect((await rowOf(s.world.tenantId, event)).status).toBe("applied");
  });

  it("the default backoff doubles: 5s after the 1st failure, 10s after the 2nd", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    failWith(new HttpError(503, "WIFI_AGENT_NOT_READY", "x"));
    await deliver(s.node, [event]);

    await drain(s);
    await drainRaw(s.node, { now: plus(6000) });
    const row = await rowOf(s.world.tenantId, event);
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at?.getTime()).toBe(plus(6000 + 10_000).getTime());
  });
});

describe("legend-oeqme worker: final failures raise one conflict", () => {
  it.each([
    [
      "502 WIFI_AUTHORIZE_REFUSED",
      new HttpError(502, "WIFI_AUTHORIZE_REFUSED", "x"),
      "WIFI_AUTHORIZE_REFUSED",
    ],
    [
      "409 WIFI_DEVICE_BOUND_ELSEWHERE",
      new HttpError(409, "WIFI_DEVICE_BOUND_ELSEWHERE", "x"),
      "WIFI_DEVICE_BOUND_ELSEWHERE",
    ],
    [
      "400 bad request",
      new HttpError(400, "WIFI_BAD_REQUEST", "x"),
      "WIFI_BAD_REQUEST",
    ],
    [
      "404 not found",
      new HttpError(404, "WIFI_SESSION_NOT_FOUND", "x"),
      "WIFI_SESSION_NOT_FOUND",
    ],
  ])(
    "%s: refused at once, one applier_refused conflict, never retried",
    async (_label, error, code) => {
      const s = await scenario();
      const event = await firstEvent(s);
      const agent = failWith(error);
      await deliver(s.node, [event]);

      await drain(s);
      expect(agent.applySession).toHaveBeenCalledTimes(1);
      const row = await rowOf(s.world.tenantId, event);
      expect(row.status).toBe("refused");
      expect(row.done_at).not.toBeNull();
      const found = await conflicts(s.world.tenantId, event.id);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        reason: "applier_refused",
        direction: "cloud_to_edge",
      });
      expect(found[0]!.detail).toContain(code);

      // A later pass neither retries nor adds a second conflict.
      await drainRaw(s.node, { now: plus(3_600_000) });
      expect(agent.applySession).toHaveBeenCalledTimes(1);
      expect(await conflicts(s.world.tenantId, event.id)).toHaveLength(1);
      expect(await receipts(s.world.tenantId, event.id)).toEqual(["applied"]);
    },
  );

  it("a transient error that lasts until maxAttempts ends as failed with one conflict", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = failWith(new HttpError(503, "WIFI_AGENT_NOT_READY", "x"));
    const backoffMs = () => 1000;
    await deliver(s.node, [event]);

    await drain(s, { maxAttempts: 3, backoffMs });
    expect((await rowOf(s.world.tenantId, event)).status).toBe("pending");
    await drainRaw(s.node, { now: plus(2000), maxAttempts: 3, backoffMs });
    expect((await rowOf(s.world.tenantId, event)).status).toBe("pending");
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);

    const last = await drainRaw(s.node, {
      now: plus(4000),
      maxAttempts: 3,
      backoffMs,
    });
    expect(last).toMatchObject({ failed: 1, applied: 0 });
    expect(agent.applySession).toHaveBeenCalledTimes(3);
    const row = await rowOf(s.world.tenantId, event);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(row.last_error).toBe("WIFI_AGENT_NOT_READY");
    const found = await conflicts(s.world.tenantId, event.id);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      reason: "applier_refused",
      direction: "cloud_to_edge",
    });

    // Failed rows are final.
    await drainRaw(s.node, { now: plus(3_600_000), maxAttempts: 3, backoffMs });
    expect(agent.applySession).toHaveBeenCalledTimes(3);
    expect(await conflicts(s.world.tenantId, event.id)).toHaveLength(1);
  });
});

// ---- 4. ordering per session ------------------------------------------------------

describe("legend-oeqme ordering per session", () => {
  it("a newer event that arrives while the older one backs off supersedes it; the final applied state is the newest", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const older = variant(event, 2, { quotaMinutes: 240 });
    const newer = variant(event, 3, { quotaMinutes: 300 });
    failWith(new HttpError(503, "WIFI_AGENT_NOT_READY", "x"));
    await deliver(s.node, [older]);
    await drain(s);
    expect((await rowOf(s.world.tenantId, older)).status).toBe("pending");

    await deliver(s.node, [newer]);
    const agent = agentWith();
    // Far past the backoff: the older row is due again, but it is no longer the newest.
    await makeDue(s.world.tenantId);
    const result = await drainRaw(s.node, { now: plus(3_600_000) });
    expect(result).toMatchObject({ applied: 1 });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(...calledWith(s, 300 * 60));
    expect((await rowOf(s.world.tenantId, older)).status).toBe("superseded");
    expect((await rowOf(s.world.tenantId, newer)).status).toBe("applied");
  });

  it("a newer event arriving while the older one backs off supersedes it even before the older one is due", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const older = variant(event, 2, { quotaMinutes: 240 });
    const newer = variant(event, 3, { quotaMinutes: 300 });
    failWith(new HttpError(503, "WIFI_AGENT_NOT_READY", "x"));
    await deliver(s.node, [older]);
    await drain(s);

    await deliver(s.node, [newer]);
    const agent = agentWith();
    await makeDue(s.world.tenantId);
    // +1s: the older row is still backing off (due at +5s); the newer row is due.
    await drainRaw(s.node, { now: plus(1000) });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(...calledWith(s, 300 * 60));
    expect((await rowOf(s.world.tenantId, newer)).status).toBe("applied");

    // The older one never reaches the agent, now or later.
    await drainRaw(s.node, { now: plus(3_600_000) });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.world.tenantId, older)).status).toBe("superseded");
  });

  it("sessions are independent: a failing session does not block another", async () => {
    const s = await scenario();
    const other = await secondSession(s);
    const event = await firstEvent(s);
    const failing = variant(event, 2, { quotaMinutes: 240 });
    const healthy = variant(event, 3, { sessionId: other, quotaMinutes: 200 });
    const agent = agentWith(async (_context, input) => {
      if ((input as { wifiSessionId: string }).wifiSessionId === s.sessionId)
        throw new HttpError(503, "WIFI_AGENT_NOT_READY", "x");
      return undefined;
    });
    await deliver(s.node, [failing, healthy]);

    const result = await drain(s);
    expect(result).toMatchObject({ applied: 1, retried: 1 });
    expect(agent.applySession).toHaveBeenCalledTimes(2);
    expect(agent.applySession).toHaveBeenCalledWith(
      ...calledWith(s, 200 * 60, other, MAC2),
    );
    expect((await rowOf(s.world.tenantId, failing)).status).toBe("pending");
    expect((await rowOf(s.world.tenantId, healthy)).status).toBe("applied");
  });
});

// ---- 5. idempotence ---------------------------------------------------------------

describe("legend-oeqme idempotence per event id", () => {
  it("the same event delivered twice leaves one row and one agent call", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);
    await deliver(s.node, [event]);
    expect(await queue(s.world.tenantId)).toHaveLength(1);

    await drain(s);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.world.tenantId, event)).status).toBe("applied");
  });

  it("the worker run twice calls the agent once", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);

    await drain(s);
    const again = await drainRaw(s.node, { now: plus(60_000) });
    expect(again).toMatchObject({ applied: 0, retried: 0, failed: 0 });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
  });

  it("a replay of an already applied event never calls the agent again", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);
    await drain(s);
    expect(agent.applySession).toHaveBeenCalledTimes(1);

    await deliver(s.node, [event]);
    await drainRaw(s.node, { now: plus(60_000) });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    const rows = await queue(s.world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("applied");
  });
});

// ---- 6. isolation -----------------------------------------------------------------

describe("legend-oeqme tenant and outlet isolation", () => {
  it("the worker of one tenant's node never touches the rows of another tenant", async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const mineEvent = await firstEvent(mine);
    const theirEvent = await firstEvent(theirs);
    const agent = agentWith();
    await deliver(mine.node, [mineEvent]);
    await deliver(theirs.node, [theirEvent]);
    await makeDue(theirs.world.tenantId);

    await drain(mine);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(
      ...calledWith(mine, 180 * 60),
    );
    expect((await rowOf(mine.world.tenantId, mineEvent)).status).toBe(
      "applied",
    );
    expect(await rowOf(theirs.world.tenantId, theirEvent)).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    await drain(theirs);
    expect(agent.applySession).toHaveBeenCalledTimes(2);
    expect((await rowOf(theirs.world.tenantId, theirEvent)).status).toBe(
      "applied",
    );
  });

  it("a node of another outlet of the same tenant sees no rows", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = agentWith();
    await deliver(s.node, [event]);
    const outletB = await registerNode(s.world, s.world.outletB);

    const result = await drain(s, {}, outletB);
    expect(result).toEqual({
      applied: 0,
      retried: 0,
      failed: 0,
      superseded: 0,
      skipped: 0,
    });
    expect(agent.applySession).not.toHaveBeenCalled();
    expect(await rowOf(s.world.tenantId, event)).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    await drain(s);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
  });
});

// ---- 7. no agent installed, prune, stop between rows ------------------------------

const emptyResult = {
  applied: 0,
  retried: 0,
  failed: 0,
  superseded: 0,
  skipped: 0,
};

describe("legend-oeqme worker: no agent installed", () => {
  it("leaves a due row pending: no attempt spent, next_attempt_at unchanged", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    await deliver(s.node, [event]);
    installWifiEnforcement(null);
    await makeDue(s.world.tenantId);
    const before = await rowOf(s.world.tenantId, event);
    expect(before.next_attempt_at?.getTime()).toBe(plus(-1000).getTime());

    const result = await drainRaw(s.node);
    expect(result).toEqual(emptyResult);
    const row = await rowOf(s.world.tenantId, event);
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(row.next_attempt_at?.getTime()).toBe(
      before.next_attempt_at?.getTime(),
    );
    expect(row.last_error).toBeNull();
    expect(row.done_at).toBeNull();
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);

    // Once an agent is installed the same row is applied.
    const agent = agentWith();
    await drainRaw(s.node);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.world.tenantId, event)).status).toBe("applied");
  });

  it("a row without a live grant is still skipped", async () => {
    const s = await scenario({ grant: false });
    const event = await firstEvent(s);
    await deliver(s.node, [event]);
    installWifiEnforcement(null);

    const result = await drain(s);
    expect(result).toEqual({ ...emptyResult, skipped: 1 });
    expect((await rowOf(s.world.tenantId, event)).status).toBe("skipped");
  });

  it("a row of an ended session is still skipped", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    await deliver(s.node, [event]);
    installWifiEnforcement(null);

    const result = await drain(s, {
      now: new Date(Date.parse(DAY_END) + 60_000),
    });
    expect(result).toEqual({ ...emptyResult, skipped: 1 });
    expect((await rowOf(s.world.tenantId, event)).status).toBe("skipped");
  });

  it("an older row is still superseded; the newest stays pending with 0 attempts", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const older = variant(event, 2, { quotaMinutes: 240 });
    const newest = variant(event, 3, { quotaMinutes: 300 });
    await deliver(s.node, [older, newest]);
    installWifiEnforcement(null);

    // The older row may be superseded at receive or in this pass (as in the
    // test above); only the end state and "nothing applied/retried" are spec'd.
    const result = await drain(s);
    expect(result).toMatchObject({ applied: 0, retried: 0, failed: 0 });
    expect((await rowOf(s.world.tenantId, older)).status).toBe("superseded");
    expect(await rowOf(s.world.tenantId, newest)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});

describe("legend-oeqme worker: prune", () => {
  const DAY = 86_400_000;

  async function setRow(
    tenantId: string,
    event: EventEnvelope,
    status: string,
    doneAt: Date | null,
    createdAt: Date,
  ) {
    await owner.query(
      `UPDATE wifi_quota_apply_queue
          SET status = $3, done_at = $4, created_at = $5
        WHERE tenant_id = $1 AND event_id = $2::uuid`,
      [
        tenantId,
        ulidToUuid(event.id),
        status,
        doneAt?.toISOString() ?? null,
        createdAt.toISOString(),
      ],
    );
  }

  it("deletes terminal rows done over 7 days ago and pending rows created over 2 days ago; keeps newer ones", async () => {
    const s = await scenario();
    const base = await firstEvent(s);
    const events = [2, 3, 4, 5, 6, 7, 8].map((seq) =>
      variant(base, seq, { quotaMinutes: 100 + seq }),
    );
    await deliver(s.node, events);
    const [
      oldApplied,
      oldFailed,
      oldSkipped,
      recentRefused,
      oldPending,
      recentPending,
      oldSuperseded,
    ] = events as [
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
    ];
    const t = s.world.tenantId;
    await setRow(t, oldApplied, "applied", plus(-8 * DAY), plus(-9 * DAY));
    await setRow(t, oldFailed, "failed", plus(-8 * DAY), plus(-9 * DAY));
    await setRow(t, oldSkipped, "skipped", plus(-8 * DAY), plus(-9 * DAY));
    await setRow(t, recentRefused, "refused", plus(-6 * DAY), plus(-9 * DAY));
    await setRow(t, oldPending, "pending", null, plus(-3 * DAY));
    await setRow(t, recentPending, "pending", null, plus(-1 * DAY));
    await setRow(
      t,
      oldSuperseded,
      "superseded",
      plus(-8 * DAY),
      plus(-9 * DAY),
    );

    const worker = await import("../edge/wifi-quota-queue-worker.ts");
    await worker.pruneWifiQuotaQueue(s.node.context, NOW);

    const left = (await queue(t)).map((row) => row.event_id).sort();
    const kept = [recentRefused, recentPending].map((e) => ulidToUuid(e.id));
    // The base event's own row (sequence 1) was never delivered: not in the queue.
    expect(left).toEqual([...kept].sort());
  });

  it("never deletes the rows of another tenant", async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const theirEvent = await firstEvent(theirs);
    await deliver(theirs.node, [theirEvent]);
    await setRow(
      theirs.world.tenantId,
      theirEvent,
      "applied",
      plus(-30 * DAY),
      plus(-31 * DAY),
    );

    const worker = await import("../edge/wifi-quota-queue-worker.ts");
    await worker.pruneWifiQuotaQueue(mine.node.context, NOW);
    expect(await queue(theirs.world.tenantId)).toHaveLength(1);
  });
});

describe("legend-oeqme worker: shouldStop", () => {
  it("stops between rows: one agent call, the other rows stay pending", async () => {
    const s = await scenario();
    const other1 = await secondSession(s);
    const other2 = await secondSession(s);
    const event = await firstEvent(s);
    const events = [
      variant(event, 2, { quotaMinutes: 150 }),
      variant(event, 3, { sessionId: other1, quotaMinutes: 160 }),
      variant(event, 4, { sessionId: other2, quotaMinutes: 170 }),
    ];
    await deliver(s.node, events);
    let stop = false;
    const agent = agentWith(async () => {
      stop = true;
      return undefined;
    });
    await makeDue(s.world.tenantId);

    const result = await drainRaw(s.node, { shouldStop: () => stop });
    expect(result).toEqual({ ...emptyResult, applied: 1 });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    const rows = await queue(s.world.tenantId);
    expect(rows.filter((row) => row.status === "applied")).toHaveLength(1);
    const waiting = rows.filter((row) => row.status === "pending");
    expect(waiting).toHaveLength(2);
    for (const row of waiting) expect(row.attempts).toBe(0);

    // A later pass without a stop signal finishes the other two.
    await drainRaw(s.node);
    expect(agent.applySession).toHaveBeenCalledTimes(3);
    expect(
      (await queue(s.world.tenantId)).every((row) => row.status === "applied"),
    ).toBe(true);
  });
});
