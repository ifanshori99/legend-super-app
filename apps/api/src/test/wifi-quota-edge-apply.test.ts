// legend-xk7az: Wi-Fi quota edge applier. Cloud side queues `wifi_quota.updated`
// for the outlet's active edge node; edge side applies it to the controller
// through the real link receive path (createDbLinkStore.applyInbound) with a
// fake WifiEnforcement installed.
//
// Written from the brief, not from the implementation. Assumptions:
// - The edge applier is installed by `registerWifiQuotaEdgeApplier()` into the
//   cloud_to_edge applier slot and the event is classified `master_data`
//   (receiver rule: a newer aggregate sequence applies, an older or equal one
//   is superseded and never reaches the agent).
// - Cloud and edge share the one test database; "the edge" is a link store
//   whose outbound direction is edge_to_cloud.
// - Real events are taken from edge_outbound_queue after a real paid-spend;
//   ordering / retry tests clone them with another sequence, id and quota.
// - Remaining seconds are (quota - used) * 60, never below 0, capped at 86400.
// - legend-oeqme: the receive path only inserts into `wifi_quota_apply_queue`
//   and never calls the agent. `drain(node)` runs one pass of
//   drainWifiQuotaQueue, which calls the agent. The receive therefore always
//   succeeds (cursor advances, receipt `applied`); an agent that is not ready
//   (503/502, 409 WIFI_GRANT_IN_FLIGHT) leaves the row `pending` (retry detail:
//   wifi-quota-edge-queue.test.ts).
// - A final agent refusal (502 WIFI_AUTHORIZE_REFUSED, 409 bound elsewhere) ends
//   the queue row as `refused` with an `applier_refused` conflict written by the
//   worker; the receipt stays `applied` and later events still apply.
// - No live grant: the queue row ends as `skipped`, the agent is not called.
// - A tenant mismatch between event and context is refused with CoreError
//   FORBIDDEN by the applier (checked by calling the applier directly).
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
import { drainWifiQuotaQueue } from "../edge/wifi-quota-queue-worker.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
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

// ---- fixtures ------------------------------------------------------------------

type Scenario = {
  world: World;
  zoneId: string;
  policyId: string;
  profileId: string;
  sessionId: string;
  node: AuthenticatedEdgeNode | null;
};

async function registerNode(
  world: World,
  outletId: string,
  role: "primary" | "standby" = "primary",
): Promise<AuthenticatedEdgeNode> {
  const registered = await registerEdgeNode(
    scopeFor(world, [outletId]),
    randomUUID(),
    {
      outletId,
      role,
      label: role === "primary" ? "Utama Wifi" : "Cadangan Wifi",
    },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

/** Tenant with a Wi-Fi policy, a member and an open session at outlet A. */
async function scenario(
  options: {
    node?: boolean;
    grant?: boolean;
    nodeOutlet?: "outletA" | "outletB";
  } = {},
): Promise<Scenario> {
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
    if (options.grant !== false)
      await client.query(
        `INSERT INTO wifi_device_grants
           (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
            speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
            renew_until, requested_at, authorized_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, 'active',
                 now() + interval '8 hours', now(), now(), now() + interval '65 minutes')`,
        [randomUUID(), world.tenantId, world.outletA, sessionId, hex64(), MAC],
      );
  });
  const node =
    options.node === false
      ? null
      : await registerNode(world, world[options.nodeOutlet ?? "outletA"]);
  return {
    world,
    zoneId,
    policyId,
    profileId: member.id,
    sessionId,
    node,
  };
}

/** A paid order of the member: adds an hour of quota (Rp45.000). */
async function pay(s: Scenario, cash = 45_000, profileId = s.profileId) {
  const orderUlid = await seedOrder(s.world.tenantId, {
    outletId: s.world.outletA,
    profileId,
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

type QueueRow = {
  edge_node_id: string;
  direction: string;
  kind: string;
  status: string;
  event: unknown;
};

async function queueRows(
  tenantId: string,
  name = "wifi_quota.updated",
): Promise<QueueRow[]> {
  const { rows } = await owner.query<QueueRow>(
    `SELECT edge_node_id, direction, kind, status, event
       FROM edge_outbound_queue
      WHERE tenant_id = $1 AND event->>'name' = $2
      ORDER BY link_seq`,
    [tenantId, name],
  );
  return rows;
}

async function queuedEvents(s: Scenario): Promise<EventEnvelope[]> {
  return (await queueRows(s.world.tenantId)).map((row) =>
    eventEnvelopeSchema.parse(row.event),
  );
}

async function sessionQuota(s: Scenario) {
  return asTenant(s.world.tenantId, async (client) => {
    const { rows } = await client.query<{ quota: number; used: number }>(
      "SELECT quota_minutes AS quota, used_minutes AS used FROM wifi_sessions WHERE id = $1",
      [s.sessionId],
    );
    return rows[0]!;
  });
}

/** A copy of a queued event with its own id, sequence and quota. */
function variant(
  event: EventEnvelope,
  sequence: number,
  payload: Record<string, unknown> = {},
): EventEnvelope {
  return {
    ...event,
    id: createUlid() as EventEnvelope["id"],
    sequence,
    idempotencyKey: `wq-${randomUUID()}`,
    payload: { ...(event.payload as Record<string, unknown>), ...payload },
  } as EventEnvelope;
}

type Call = (context: unknown, input: unknown) => Promise<unknown>;

// ---- edge side -----------------------------------------------------------------

function fakeAgent() {
  // legend-415: the worker only marks a row applied for an active grant view.
  const applySession = vi.fn<Call>(async (_context, input) => ({
    status: "active",
    speedTier: (input as { speedTier: string }).speedTier,
  }));
  const endSession = vi.fn<Call>(async () => undefined);
  installWifiEnforcement({
    applySession,
    endSession,
  } as unknown as WifiEnforcement);
  return { applySession, endSession };
}

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

/**
 * One worker pass (the only caller of the agent). Never-tried rows are made due
 * just before NOW first; the pass runs at NOW, inside the session's day.
 */
async function drain(node: AuthenticatedEdgeNode) {
  await owner.query(
    `UPDATE wifi_quota_apply_queue
        SET next_attempt_at = $2
      WHERE tenant_id = $1 AND status = 'pending' AND attempts = 0`,
    [node.context.tenant.tenantId, new Date(NOW.getTime() - 1000)],
  );
  return drainWifiQuotaQueue({ context: node.context, now: NOW });
}

/** Status of the apply-queue row of one event. */
async function applyStatus(tenantId: string, eventId: string) {
  const { rows } = await owner.query<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM wifi_quota_apply_queue WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
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

async function conflicts(tenantId: string, eventId: string) {
  const { rows } = await owner.query<{ reason: string }>(
    "SELECT reason FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
  return rows.map((row) => row.reason);
}

const appliedWith = (s: Scenario, remainingSeconds: number) => [
  expect.anything(),
  {
    outletId: s.world.outletA,
    wifiSessionId: s.sessionId,
    controllerDeviceId: MAC,
    speedTier: "full",
    fullSpeedKbps: 20_000,
    baseSpeedKbps: 2_000,
    remainingSeconds,
    sessionEndsAt: DAY_END,
  },
];

/** The cloud paid-spend of the scenario, returned as the queued event. */
async function firstEvent(s: Scenario): Promise<EventEnvelope> {
  await pay(s);
  const events = await queuedEvents(s);
  expect(events).toHaveLength(1);
  return events[0]!;
}

// ---- 1. cloud queues the event -------------------------------------------------

describe("legend-xk7az cloud forwarding", () => {
  it("a paid spend that changes the quota queues exactly one wifi_quota.updated for the outlet's edge node", async () => {
    const s = await scenario();
    await pay(s);
    const rows = await queueRows(s.world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      edge_node_id: s.node!.scope.edgeNodeId,
      direction: "cloud_to_edge",
      kind: "master_data",
      status: "pending",
    });
    const event = eventEnvelopeSchema.parse(rows[0]!.event);
    expect(event.name).toBe("wifi_quota.updated");
    expect(event.tenantId).toBe(s.world.tenantId);
    expect(event.outletId).toBe(s.world.outletA);
    expect(event.payload).toMatchObject({
      sessionId: s.sessionId,
      quotaMinutes: 180,
      speedTier: "full",
      fullSpeedKbps: 20_000,
      baseSpeedKbps: 2_000,
      sessionEndsAt: DAY_END,
    });
  });

  it("an outlet without an edge node queues nothing", async () => {
    const s = await scenario({ node: false });
    await pay(s);
    expect((await sessionQuota(s)).quota).toBe(180);
    expect(await queueRows(s.world.tenantId)).toHaveLength(0);
  });

  it("a spend by a member with no open session queues nothing", async () => {
    const s = await scenario();
    const stranger = await seedMember(s.world.tenantId);
    await pay(s, 45_000, stranger.id);
    expect(await queueRows(s.world.tenantId)).toHaveLength(0);
  });
});

// ---- 2. tenant and outlet isolation --------------------------------------------

describe("legend-xk7az isolation", () => {
  it("the node of another tenant gets nothing", async () => {
    const mine = await scenario();
    const other = await scenario();
    await pay(mine);
    expect(await queueRows(mine.world.tenantId)).toHaveLength(1);
    expect(await queueRows(other.world.tenantId)).toHaveLength(0);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM edge_outbound_queue WHERE edge_node_id = $1",
      [other.node!.scope.edgeNodeId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("a node of another outlet of the same tenant gets nothing", async () => {
    const s = await scenario({ nodeOutlet: "outletB" });
    await pay(s);
    expect((await sessionQuota(s)).quota).toBe(180);
    expect(await queueRows(s.world.tenantId)).toHaveLength(0);
  });

  it("the applier refuses an event whose tenant differs from the context (FORBIDDEN)", async () => {
    const s = await scenario();
    const foreign = await scenario();
    const event = await firstEvent(s);
    const agent = fakeAgent();
    const meta: EdgeApplyMeta = {
      edgeNodeId: foreign.node!.scope.edgeNodeId,
      direction: "cloud_to_edge",
      kind: "master_data",
      context: foreign.node!.context,
    };
    await expect(
      withTenant(db, foreign.node!.context, (tx) =>
        edgeEventApplier("cloud_to_edge").apply(tx, event, meta),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(agent.applySession).not.toHaveBeenCalled();
  });
});

// ---- 3. apply through the link --------------------------------------------------

describe("legend-xk7az edge applier through the link", () => {
  it("applies the quota once with the controller id of the live grant", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = fakeAgent();
    await deliver(s.node!, [event]);
    expect(agent.applySession).not.toHaveBeenCalled();
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(
      ...appliedWith(s, 180 * 60),
    );
    expect(agent.endSession).not.toHaveBeenCalled();
    expect(await receipts(s.world.tenantId, event.id)).toEqual(["applied"]);
    expect((await applyStatus(s.world.tenantId, event.id)).status).toBe(
      "applied",
    );
  });

  it("remaining seconds are (quota - used) * 60", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = fakeAgent();
    await deliver(s.node!, [
      variant(event, 5, { quotaMinutes: 300, usedMinutes: 100 }),
    ]);
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledWith(
      ...appliedWith(s, 200 * 60),
    );
  });

  it("a spent quota is applied as base speed with 0 seconds left", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = fakeAgent();
    await deliver(s.node!, [
      variant(event, 5, {
        quotaMinutes: 120,
        usedMinutes: 120,
        speedTier: "base",
        reason: "quota_spent",
      }),
    ]);
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ speedTier: "base", remainingSeconds: 0 }),
    );
    expect(agent.endSession).not.toHaveBeenCalled();
  });
});

// ---- 4. duplicates and ordering --------------------------------------------------

describe("legend-xk7az duplicate and reversed delivery", () => {
  it("the same event delivered twice applies once", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const agent = fakeAgent();
    await deliver(s.node!, [event]);
    await drain(s.node!);
    await deliver(s.node!, [event]);
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(await cursor(s.node!)).toBe(2);
  });

  it("sequence 2 then sequence 1: the older one is skipped and the quota is never lowered", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const newer = variant(event, 2, { quotaMinutes: 300, usedMinutes: 0 });
    const older = variant(event, 1, { quotaMinutes: 180, usedMinutes: 0 });
    const agent = fakeAgent();
    await deliver(s.node!, [newer]);
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenLastCalledWith(
      ...appliedWith(s, 300 * 60),
    );
    await deliver(s.node!, [older]);
    await drain(s.node!);
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(await receipts(s.world.tenantId, older.id)).not.toContain("applied");
  });
});

// ---- 5. agent failure retries ----------------------------------------------------

/**
 * Receive succeeds without touching the agent; the worker pass meets the
 * failing agent and leaves the row pending (retry detail: wifi-quota-edge-queue).
 */
async function expectReceiveSurvivesAgentFailure(status: number, code: string) {
  const s = await scenario();
  const event = await firstEvent(s);
  const failing = vi.fn<Call>(async () => {
    throw new HttpError(status, code, "Agen belum siap.");
  });
  installWifiEnforcement({
    applySession: failing,
    endSession: vi.fn(async () => undefined),
  } as unknown as WifiEnforcement);

  const before = await cursor(s.node!);
  await expect(deliver(s.node!, [event])).resolves.toBeUndefined();
  expect(failing).not.toHaveBeenCalled();
  expect(await cursor(s.node!)).toBe(before + 1);
  expect(await receipts(s.world.tenantId, event.id)).toEqual(["applied"]);
  expect(await applyStatus(s.world.tenantId, event.id)).toMatchObject({
    status: "pending",
    attempts: 0,
  });

  await drain(s.node!);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(await applyStatus(s.world.tenantId, event.id)).toMatchObject({
    status: "pending",
    attempts: 1,
  });
  expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
  expect(await cursor(s.node!)).toBe(before + 1);
}

describe("legend-xk7az agent unavailable", () => {
  it.each([
    ["503 WIFI_AGENT_NOT_READY", 503, "WIFI_AGENT_NOT_READY"],
    ["502 controller error", 502, "WIFI_CONTROLLER_ERROR"],
  ])(
    "%s does not fail the receive; the row stays pending",
    async (_label, status, code) => {
      await expectReceiveSurvivesAgentFailure(status, code);
    },
  );

  it("the cloud keeps the event pending until the edge acknowledges it", async () => {
    const s = await scenario();
    await pay(s);
    const rows = await queueRows(s.world.tenantId);
    expect(rows.map((row) => row.status)).toEqual(["pending"]);
  });
});

// ---- 6. edge offline ---------------------------------------------------------------

describe("legend-xk7az edge offline", () => {
  it("events queued while the link is down apply in order; the final state is the newest", async () => {
    const s = await scenario();
    await pay(s);
    await pay(s);
    await pay(s);
    const events = await queuedEvents(s);
    expect(events).toHaveLength(3);
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(3);

    const agent = fakeAgent();
    await deliver(s.node!, events);
    await drain(s.node!);

    const { quota, used } = await sessionQuota(s);
    expect(quota).toBeGreaterThan(180);
    const newest = events[events.length - 1]!.payload as {
      quotaMinutes: number;
    };
    expect(newest.quotaMinutes).toBe(quota);
    const lastCall = agent.applySession.mock.calls.at(-1)!;
    expect(lastCall[1]).toMatchObject({
      wifiSessionId: s.sessionId,
      controllerDeviceId: MAC,
      remainingSeconds: Math.min(86_400, (quota - used) * 60),
    });
    // The applied quota never goes down along the way.
    const remaining = agent.applySession.mock.calls.map(
      (call) => (call[1] as { remainingSeconds: number }).remainingSeconds,
    );
    expect(remaining).toEqual([...remaining].sort((a, b) => a - b));
  });
});

// ---- 7. no live grant ---------------------------------------------------------------

describe("legend-xk7az session without a live grant", () => {
  it("does not touch the agent, consumes the event and raises no error", async () => {
    const s = await scenario({ grant: false });
    const event = await firstEvent(s);
    const agent = fakeAgent();
    await expect(deliver(s.node!, [event])).resolves.toBeUndefined();
    await drain(s.node!);
    expect(agent.applySession).not.toHaveBeenCalled();
    expect(agent.endSession).not.toHaveBeenCalled();
    expect(await cursor(s.node!)).toBe(1);
    expect((await applyStatus(s.world.tenantId, event.id)).status).toBe(
      "skipped",
    );
    expect(await receipts(s.world.tenantId, event.id)).toEqual(["applied"]);
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
  });
});

// ---- 8. agent refusal ----------------------------------------------------------------

describe("legend-xk7az agent refuses the device", () => {
  it("409 WIFI_DEVICE_BOUND_ELSEWHERE ends the queue row as refused with an applier_refused conflict and the queue goes on", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const refused = variant(event, 2, { quotaMinutes: 240 });
    const next = variant(event, 3, { quotaMinutes: 300 });
    const applySession = vi
      .fn<Call>(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new HttpError(
          409,
          "WIFI_DEVICE_BOUND_ELSEWHERE",
          "Perangkat terikat ke sesi lain.",
        );
      });
    installWifiEnforcement({
      applySession,
      endSession: vi.fn(async () => undefined),
    } as unknown as WifiEnforcement);

    await expect(deliver(s.node!, [refused])).resolves.toBeUndefined();
    expect(applySession).not.toHaveBeenCalled();
    await drain(s.node!);
    expect(applySession).toHaveBeenCalledTimes(1);
    expect((await applyStatus(s.world.tenantId, refused.id)).status).toBe(
      "refused",
    );
    expect(await receipts(s.world.tenantId, refused.id)).toEqual(["applied"]);
    expect(await conflicts(s.world.tenantId, refused.id)).toEqual([
      "applier_refused",
    ]);
    expect(await cursor(s.node!)).toBe(1);

    // The next event is not stalled behind the refused one.
    await deliver(s.node!, [next]);
    await drain(s.node!);
    expect(applySession).toHaveBeenCalledTimes(2);
    expect(applySession).toHaveBeenLastCalledWith(...appliedWith(s, 300 * 60));
    expect(await cursor(s.node!)).toBe(2);
  });
});

// ---- agent answers that retry or refuse for good (classifyAgentError) -------------

describe("legend-xk7az agent answer classification", () => {
  it("409 WIFI_GRANT_IN_FLIGHT is transient: the receive succeeds and the row stays pending, no conflict", async () => {
    await expectReceiveSurvivesAgentFailure(409, "WIFI_GRANT_IN_FLIGHT");
  });

  it("502 WIFI_AUTHORIZE_REFUSED is final: the queue row ends refused with an applier_refused conflict, the next event still applies", async () => {
    const s = await scenario();
    const event = await firstEvent(s);
    const refused = variant(event, 2, { quotaMinutes: 240 });
    const next = variant(event, 3, { quotaMinutes: 300 });
    const applySession = vi.fn<Call>(async () => undefined);
    applySession.mockImplementationOnce(async () => {
      throw new HttpError(
        502,
        "WIFI_AUTHORIZE_REFUSED",
        "Pengendali menolak perubahan.",
      );
    });
    installWifiEnforcement({
      applySession,
      endSession: vi.fn(async () => undefined),
    } as unknown as WifiEnforcement);

    await expect(deliver(s.node!, [refused])).resolves.toBeUndefined();
    expect(applySession).not.toHaveBeenCalled();
    await drain(s.node!);
    expect(applySession).toHaveBeenCalledTimes(1);
    expect((await applyStatus(s.world.tenantId, refused.id)).status).toBe(
      "refused",
    );
    expect(await receipts(s.world.tenantId, refused.id)).toEqual(["applied"]);
    expect(await conflicts(s.world.tenantId, refused.id)).toEqual([
      "applier_refused",
    ]);
    expect(await cursor(s.node!)).toBe(1);

    await deliver(s.node!, [next]);
    await drain(s.node!);
    expect(applySession).toHaveBeenCalledTimes(2);
    expect(applySession).toHaveBeenLastCalledWith(...appliedWith(s, 300 * 60));
    expect(await cursor(s.node!)).toBe(2);
  });
});

// ---- primary and standby ------------------------------------------------------------

describe("legend-xk7az outlet with a primary and a standby node", () => {
  it("queues the event for both nodes even when the primary heartbeat is stale; a node without a live grant consumes it as a no-op", async () => {
    // No grant row: neither node holds a live grant for the session.
    const s = await scenario({ grant: false });
    const primary = s.node!;
    const standby = await registerNode(s.world, s.world.outletA, "standby");
    await asTenant(s.world.tenantId, async (client) => {
      await client.query(
        "UPDATE edge_nodes SET last_heartbeat_at = now() - interval '300 seconds' WHERE id = $1",
        [primary.scope.edgeNodeId],
      );
      await client.query(
        "UPDATE edge_nodes SET last_heartbeat_at = now() - interval '5 seconds' WHERE id = $1",
        [standby.scope.edgeNodeId],
      );
    });

    await pay(s);
    const rows = await queueRows(s.world.tenantId);
    expect(rows.map((row) => row.edge_node_id).sort()).toEqual(
      [primary.scope.edgeNodeId, standby.scope.edgeNodeId].sort(),
    );
    for (const row of rows)
      expect(row).toMatchObject({
        direction: "cloud_to_edge",
        kind: "master_data",
        status: "pending",
      });
    const event = eventEnvelopeSchema.parse(rows[0]!.event);
    expect(event.name).toBe("wifi_quota.updated");

    const agent = fakeAgent();
    await expect(deliver(standby, [event])).resolves.toBeUndefined();
    await expect(deliver(primary, [event])).resolves.toBeUndefined();
    await drain(standby);
    await drain(primary);
    expect((await applyStatus(s.world.tenantId, event.id)).status).toBe(
      "skipped",
    );
    expect(agent.applySession).not.toHaveBeenCalled();
    expect(agent.endSession).not.toHaveBeenCalled();
    expect(await cursor(standby)).toBe(1);
    expect(await cursor(primary)).toBe(1);
    expect(await conflicts(s.world.tenantId, event.id)).toEqual([]);
  });
});
