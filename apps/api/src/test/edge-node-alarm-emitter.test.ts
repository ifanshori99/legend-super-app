// legend-0cjzz (S2, uvnll), edge side: the emitter turns the device-registry
// "hard stale" state into ordered `edge_node_alarm.raised` / `.cleared` events
// in the edge's outbound queue. Written from docs/design/edge-status-cloud.md
// (D2, D3, tests T5-T8), not from the implementation. The edge and the cloud
// share one disposable test database here; only the edge outbox is inspected.
//
// Assumed shape of the (not yet existing) emitter, apps/api/src/edge/node-alarm.ts:
//   createNodeAlarmEmitter({
//     database,           // the edge database (`db`), like createDbPrintStore
//     context,            // edgeNodeContext({ tenantId, outletId })
//     tenantId, outletId, edgeNodeId,
//     // The puller's current state: the wanted alarm state and the base the age
//     // is measured from (lastPulledAt ?? "boot:" + startedAt, design D2).
//     getDeviceRegistryState: () => { hardStale: boolean; lastPulledAt: Date | null; startedAt: Date },
//     maxStaleSeconds,    // EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS
//     now?: () => Date,
//   }) -> { reconcile(): Promise<void> }
// - A failed enqueue may make reconcile() reject or resolve: tests accept both.
// - The "last emitted state" is read from edge_outbound_queue (any status), so
//   a new emitter instance models a process restart.
// - Each test uses its own node (the last emitted state is per node) and
//   revokes it afterwards, so only one active node stays in the outlet.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  EDGE_NODE_ALARM_AGGREGATE,
  EDGE_NODE_ALARM_CLEARED,
  EDGE_NODE_ALARM_RAISED,
  edgeNodeAlarmClearedPayloadSchema,
  edgeNodeAlarmRaisedPayloadSchema,
} from "@starter/shared/edge/node-alarm";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { createNodeAlarmEmitter } from "../edge/node-alarm.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import * as queue from "../services/edge-queue.service.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const context = edgeNodeContext({ tenantId, outletId });
const MAX_STALE_SECONDS = 3600;
const HOUR = 3_600_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});

type RegistryState = {
  hardStale: boolean;
  lastPulledAt: Date | null;
  startedAt: Date;
};

type QueuedRow = {
  link_seq: number;
  status: string;
  direction: string;
  kind: string;
  event: {
    id: string;
    name: string;
    version: number;
    aggregateType: string;
    aggregateId: string;
    sequence: number;
    idempotencyKey: string;
    tenantId: string;
    outletId: string;
    payload: Record<string, unknown>;
  };
};

const nodes: string[] = [];
let nodeId = "";
let registry: RegistryState;

async function withOwner<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function newNode() {
  nodeId = randomUUID();
  nodes.push(nodeId);
  await withOwner((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, 'standby', 'active', $4, $5)`,
      [nodeId, tenantId, outletId, `alarm-${nodeId}`, "a".repeat(64)],
    ),
  );
}

const revokeNodes = () =>
  withOwner((client) =>
    client.query(
      "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = ANY($1::uuid[]) AND status = 'active'",
      [nodes],
    ),
  );

async function alarmRows(): Promise<QueuedRow[]> {
  return withOwner(async (client) => {
    const { rows } = await client.query<QueuedRow>(
      `SELECT link_seq, status, direction, kind, event FROM edge_outbound_queue
        WHERE edge_node_id = $1 AND event->>'aggregateType' = $2
        ORDER BY link_seq`,
      [nodeId, EDGE_NODE_ALARM_AGGREGATE],
    );
    return rows;
  });
}

const names = async () => (await alarmRows()).map((row) => row.event.name);

function makeEmitter() {
  return createNodeAlarmEmitter({
    database: db,
    context,
    tenantId,
    outletId,
    edgeNodeId: nodeId,
    getDeviceRegistryState: () => registry,
    maxStaleSeconds: MAX_STALE_SECONDS,
    now: () => new Date(),
  });
}

/** Runs reconcile() and tolerates a rejection (a failed enqueue may throw). */
const reconcileLenient = (emitter: ReturnType<typeof makeEmitter>) =>
  emitter.reconcile().catch(() => undefined);

const hardStaleSince = (lastPulledAt: Date | null): RegistryState => ({
  hardStale: true,
  lastPulledAt,
  startedAt: new Date(Date.now() - 100 * HOUR),
});
const fresh = (lastPulledAt: Date): RegistryState => ({
  hardStale: false,
  lastPulledAt,
  startedAt: new Date(Date.now() - 100 * HOUR),
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await revokeNodes();
});

afterAll(async () => {
  try {
    await revokeNodes();
  } finally {
    await owner.end();
  }
});

describe("legend-0cjzz edge emitter: hard stale raises one alarm event", () => {
  it("T5 a hard stale transition queues exactly one raised event; a second reconcile keeps one row", async () => {
    await newNode();
    const lastPulledAt = new Date(Date.now() - 80 * HOUR);
    registry = hardStaleSince(lastPulledAt);
    const emitter = makeEmitter();

    await emitter.reconcile();
    await emitter.reconcile();

    const rows = await alarmRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      direction: "edge_to_cloud",
      kind: "transaction_event",
      status: "pending",
    });
    expect(row!.event).toMatchObject({
      name: EDGE_NODE_ALARM_RAISED,
      version: 1,
      aggregateType: EDGE_NODE_ALARM_AGGREGATE,
      sequence: 1,
      tenantId,
      outletId,
    });
    expect(row!.event.id).toMatch(ULID);
    expect(row!.event.aggregateId).toBe(row!.event.id);
    expect(row!.event.idempotencyKey).toBe(
      `${EDGE_NODE_ALARM_RAISED}:${row!.event.id}`,
    );
    // The payload follows the strict shared contract and carries no scope ids.
    expect(edgeNodeAlarmRaisedPayloadSchema.parse(row!.event.payload)).toEqual({
      kind: "device_registry_hard_stale",
      lastPulledAt: lastPulledAt.toISOString(),
      maxStaleSeconds: MAX_STALE_SECONDS,
    });
    const text = JSON.stringify(row!.event.payload);
    for (const id of [tenantId, outletId, nodeId])
      expect(text).not.toContain(id);
  });

  it("T5 a replica that never pulled raises with lastPulledAt null", async () => {
    await newNode();
    registry = hardStaleSince(null);
    await makeEmitter().reconcile();
    const [row] = await alarmRows();
    expect(row!.event.name).toBe(EDGE_NODE_ALARM_RAISED);
    expect(row!.event.payload).toMatchObject({ lastPulledAt: null });
  });

  it("T5 two concurrent reconcile calls still queue one event", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    const emitter = makeEmitter();
    await Promise.all([
      emitter.reconcile(),
      emitter.reconcile(),
      emitter.reconcile(),
    ]);
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);
  });

  it("T5 a fresh replica that never raised queues nothing", async () => {
    await newNode();
    registry = fresh(new Date(Date.now() - 1 * HOUR));
    const emitter = makeEmitter();
    await emitter.reconcile();
    await emitter.reconcile();
    expect(await alarmRows()).toHaveLength(0);
  });
});

describe("legend-0cjzz edge emitter: recovery queues cleared after raised", () => {
  it("T6 clearing queues one cleared event after the raised one, in order", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    const emitter = makeEmitter();
    await emitter.reconcile();

    const pulledAgain = new Date();
    registry = fresh(pulledAgain);
    await emitter.reconcile();
    await emitter.reconcile();

    const rows = await alarmRows();
    expect(rows.map((row) => row.event.name)).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
    ]);
    // pg returns bigint columns as strings.
    expect(Number(rows[0]!.link_seq)).toBeLessThan(Number(rows[1]!.link_seq));
    const cleared = rows[1]!.event;
    expect(cleared).toMatchObject({
      version: 1,
      aggregateType: EDGE_NODE_ALARM_AGGREGATE,
      sequence: 1,
    });
    expect(cleared.id).toMatch(ULID);
    expect(cleared.aggregateId).toBe(cleared.id);
    expect(cleared.id).not.toBe(rows[0]!.event.id);
    expect(cleared.idempotencyKey).toBe(
      `${EDGE_NODE_ALARM_CLEARED}:${cleared.id}`,
    );
    expect(edgeNodeAlarmClearedPayloadSchema.parse(cleared.payload)).toEqual({
      kind: "device_registry_hard_stale",
      lastPulledAt: pulledAgain.toISOString(),
    });
  });

  it("T6 a second episode with a new base queues a new raised event with a new id", async () => {
    await newNode();
    const emitter = makeEmitter();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    await emitter.reconcile();
    registry = fresh(new Date(Date.now() - 60_000));
    await emitter.reconcile();
    registry = hardStaleSince(new Date(Date.now() - 75 * HOUR));
    await emitter.reconcile();

    const rows = await alarmRows();
    expect(rows.map((row) => row.event.name)).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
      EDGE_NODE_ALARM_RAISED,
    ]);
    expect(new Set(rows.map((row) => row.event.id)).size).toBe(3);
  });
});

describe("legend-0cjzz edge emitter: ids are unique per transition", () => {
  it("T6 raised(L1), cleared with no new pull, raised(L1) again queues three rows with three ids", async () => {
    await newNode();
    const emitter = makeEmitter();
    const l1 = new Date(Date.now() - 80 * HOUR);
    registry = hardStaleSince(l1);
    await emitter.reconcile();
    // Not hard stale any more, yet no pull happened: same base L1.
    registry = fresh(l1);
    await emitter.reconcile();
    registry = hardStaleSince(l1);
    await emitter.reconcile();

    const rows = await alarmRows();
    expect(rows.map((row) => row.event.name)).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
      EDGE_NODE_ALARM_RAISED,
    ]);
    expect(new Set(rows.map((row) => row.event.id)).size).toBe(3);
  });

  it("T6 a failed enqueue retried after a restart keeps the same event id", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    const enqueue = vi
      .spyOn(queue, "enqueueEdgeEvent")
      .mockRejectedValueOnce(new Error("outbound queue unavailable"));
    await reconcileLenient(makeEmitter());
    await makeEmitter().reconcile();
    await makeEmitter().reconcile();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);
    const firstTry = eventEnvelopeSchema.parse(enqueue.mock.calls[0]![2].event);
    expect((await alarmRows())[0]!.event.id).toBe(firstTry.id);
  });
});

describe("legend-0cjzz edge emitter: retry keeps the order", () => {
  it("T7 a failed raised enqueue, then hard stale ends before the retry: never cleared before raised", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    const enqueue = vi
      .spyOn(queue, "enqueueEdgeEvent")
      .mockRejectedValueOnce(new Error("outbound queue unavailable"));
    const emitter = makeEmitter();

    await reconcileLenient(emitter);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await alarmRows()).toHaveLength(0);

    registry = fresh(new Date());
    await reconcileLenient(emitter);
    await reconcileLenient(emitter);

    // Either nothing (the alarm never reached the queue) or raised then cleared.
    expect([
      [],
      [EDGE_NODE_ALARM_RAISED, EDGE_NODE_ALARM_CLEARED],
    ]).toContainEqual(await names());
  });

  it("T7 a failed raised enqueue is retried by the next reconcile; cleared follows it", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    vi.spyOn(queue, "enqueueEdgeEvent").mockRejectedValueOnce(
      new Error("outbound queue unavailable"),
    );
    const emitter = makeEmitter();

    await reconcileLenient(emitter);
    expect(await alarmRows()).toHaveLength(0);

    await emitter.reconcile();
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);

    registry = fresh(new Date());
    await emitter.reconcile();
    expect(await names()).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
    ]);
  });

  it("T7 a failed cleared enqueue is retried and keeps one cleared event", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    const emitter = makeEmitter();
    await emitter.reconcile();

    registry = fresh(new Date());
    vi.spyOn(queue, "enqueueEdgeEvent").mockRejectedValueOnce(
      new Error("outbound queue unavailable"),
    );
    await reconcileLenient(emitter);
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);

    await emitter.reconcile();
    await emitter.reconcile();
    expect(await names()).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
    ]);
  });
});

describe("legend-0cjzz edge emitter: restart", () => {
  it("T8 last outbox row is raised (pending), process restarts, puller fresh: first reconcile queues cleared", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    await makeEmitter().reconcile();
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);

    // New emitter instance = new process: no memory of the raised event.
    registry = fresh(new Date());
    const restarted = makeEmitter();
    await restarted.reconcile();
    await restarted.reconcile();

    expect(await names()).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
    ]);
  });

  it("T8 an acked raised row still counts as the last emitted state", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    await makeEmitter().reconcile();
    await withOwner((client) =>
      client.query(
        "UPDATE edge_outbound_queue SET status = 'acked', acked_at = now() WHERE edge_node_id = $1 AND event->>'aggregateType' = $2",
        [nodeId, EDGE_NODE_ALARM_AGGREGATE],
      ),
    );

    registry = fresh(new Date());
    await makeEmitter().reconcile();

    const rows = await alarmRows();
    expect(rows.map((row) => row.event.name)).toEqual([
      EDGE_NODE_ALARM_RAISED,
      EDGE_NODE_ALARM_CLEARED,
    ]);
    expect(rows[0]!.status).toBe("acked");
  });

  it("T8 a restart while still hard stale does not queue a second raised event", async () => {
    await newNode();
    registry = hardStaleSince(new Date(Date.now() - 80 * HOUR));
    await makeEmitter().reconcile();
    await makeEmitter().reconcile();
    expect(await names()).toEqual([EDGE_NODE_ALARM_RAISED]);
  });

  it("T8 a fresh puller after a restart with no earlier alarm queues nothing", async () => {
    await newNode();
    registry = fresh(new Date());
    await makeEmitter().reconcile();
    expect(await alarmRows()).toHaveLength(0);
  });
});
