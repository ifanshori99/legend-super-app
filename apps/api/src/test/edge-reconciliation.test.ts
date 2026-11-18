// legend-kai: cloud-side reconciliation of the edge digest (what the edge sent)
// against what the cloud actually received, up to a link_seq watermark.
// Written from the card brief, not from the implementation.
//
// Fail-first: services/edge-reconciliation.service.ts, services/edge-txn-ledger.service.ts,
// the edge_txn_ledger and edge_reconciliation_runs tables do not exist yet, so
// the file fails at import (missing module) until the implementation lands.
//
// Assumptions (the brief does not pin them down):
// - The "edge" and the "cloud" share one disposable database here. The edge side
//   is driven with enqueueEdgeEvent (which writes the ledger); the cloud side
//   receives through the real Postgres link store (applyInbound) with the real
//   POS deferred applier, so edge_inbound_events + edge_deferred_events are real.
// - A true "mismatch" is produced by changing the digest the edge reports (the
//   digest is the reconciliation input), never by tampering with cloud tables.
// - The persisted edge_totals / cloud_totals jsonb have the same shape as
//   digest.totals ({[eventName]: {count, amountIdr}}), and diffs carry money as
//   decimal strings.
// - Reconcile writes exactly one row (edge_reconciliation_runs) and nothing else
//   for the tenant: every other tenant table is unchanged (counts and content of
//   the money-bearing edge tables), so no party can be paid more by a check run.
// - Wrong tenant -> NOT_FOUND. Wrong outlet scope -> any refusal (code not pinned).
//   Listing another tenant's node either rejects or returns no runs.
// - (architect review) Only order.submitted/paid/voided/refunded are reconciled.
//   A stock.moved or order.item_added in the same link is received by the cloud
//   but is in neither the edge digest nor the cloud totals.
// - (architect review) After an edge database rebuild the cloud cursor row has
//   a non-zero peer_seq_offset: the cloud's inbound link_seq and received_in_seq
//   are the edge number plus the offset. Set up with trigger-legal SQL (the
//   guards allow the offset only on a switch from one instance to another, with
//   cursors forward-only): received_in_seq = 3, instance J1 adopted at offset 0,
//   then instance J2 with offset 3 (as the rebase would). The cloud store is
//   then bound with edgeInstanceId = J2, and is assumed to return the edge
//   numbering from lastReceivedInbound() and to write link_seq + offset in
//   applyInbound. The edge outbox is read before the rebase (one shared test
//   database: the edge-side store would refuse a row bound to another instance). Reconcile must count only the new instance's window
//   (offset, offset + through] and judge "behind" on received_in_seq - offset.
// - A digest totals key that is not a reconciled event name ("toString",
//   "__proto__", "constructor") is refused: 4xx from the route, a clean 4xx-style
//   error (code or status < 500, never a TypeError) from the service, no run row.
// - Route: POST/GET /api/edge-nodes/:edgeNodeId/reconciliation, permission
//   device.registry.manage in the node's outlet (as the edge-nodes routes); the
//   body is the digest with edgeNodeId equal to the path id. Success is 200 or
//   201, bodies wrapped as { data }. Validation failure is 400 or 422.
// - (fix 3, ledger baseline) The ledger can be added mid-life: an edge that already
//   sent K events when the ledger migration landed has no ledger rows for them,
//   but the cloud counted them. The edge records a baseline in
//   edge_txn_ledger_baselines (tenant_id, outlet_id, edge_node_id, from_link_seq;
//   missing row = 0) and the digest reports it as fromLinkSeq. The cloud window is
//   (offset + fromLinkSeq, offset + throughLinkSeq]. The scenario is emulated with
//   enqueue (which writes the ledger), then wiping the ledger rows as the owner
//   (falling back to session_replication_role = replica if a guard blocks the
//   delete) and inserting the baseline row. A digest with fromLinkSeq >
//   throughLinkSeq is refused (4xx / clean error, no run row); fromLinkSeq equal to
//   throughLinkSeq is a valid empty window.
// - Round 2 (docs/briefs/470-edge-upsync-codex-fixes.md, decisions in the card
//   brief):
//   * Epoch: the digest carries edgeInstanceId (edge_nodes.instance_id of the
//     node row). The cloud's active epoch is sync_cursors.peer_instance_id of the
//     edge_to_cloud row. A digest whose edgeInstanceId differs from it (or while it
//     is NULL) is status 'stale': no totals comparison, cloud_totals {} and
//     diffs []. Order: stale, then behind, then totals. The harness sets
//     edge_nodes.instance_id in newWorld and adopts it as peer_instance_id (NULL ->
//     id, the same trigger-legal step as the J1 adoption below) in digestOf, i.e.
//     what the cloud link does on hello. digestOf(world, false) skips that.
//   * Runs store from_link_seq (NOT NULL default 0) and edge_instance_id (uuid) next
//     to through_link_seq for every status incl. stale; the run DTO and the list
//     expose fromLinkSeq, throughLinkSeq, edgeInstanceId. edge_totals of a stale run
//     is not asserted.
//   * Identity: totals entries carry idHash (decimal, sum of
//     eventIdentityHash(event id) mod 2^64). The cloud sums the same hash over the
//     inbound rows' envelope ids, compares count, amount AND idHash, and a diff
//     entry is {eventName, edgeCount, cloudCount, edgeAmountIdr, cloudAmountIdr,
//     edgeIdHash, cloudIdHash}. A lost event plus an extra event of the same
//     rupiah keeps count and amount equal: only idHash tells -> mismatch. The test
//     edits the edge outbox the cloud receives (a different event id of equal
//     amount in place of one event).
//   * Bounds: digest amountIdr is digits only and <= 9223372036854775807 (4xx
//     above, from the route and a clean error from the service); idHash is digits
//     only and < 2^64.
// - KNOWN LIMITATION (not tested, follow-up in the legend-b3k area): a standby
//   re-send that the cloud skips as already_received counts on the edge ledger but
//   not on the cloud, so a standby promotion can still show a false mismatch.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  revokeEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
import {
  listEdgeReconciliationRuns,
  reconcileEdgeTransactions,
} from "../services/edge-reconciliation.service.ts";
import {
  buildEdgeTxnDigest,
  eventIdentityHash,
} from "../services/edge-txn-ledger.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Member = { client: ReturnType<typeof agent> };
type Digest = Awaited<ReturnType<typeof buildEdgeTxnDigest>>;
type World = {
  node: AuthenticatedEdgeNode;
  credential: string;
  outletId: string;
  tenant: IsolatedTenant;
  instanceId: string;
};

const TWO_64 = 18446744073709551616n;
const MAX_BIGINT = 9223372036854775807n;

const actor = randomUUID();
let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let managerA: Member; // device.registry.manage, tenant-wide, tenant A
let managerA1: Member; // device.registry.manage in tenant A's first outlet only
let plainA: Member; // signed in, no device.registry.manage
let managerB: Member; // device.registry.manage, tenant B

const contextOf = (
  tenantId: string,
  outletIds: string[] | "tenant",
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    outletIds === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );

async function asOwnerTenant<T>(
  tenantId: string,
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

/** Run an owner-side statement; falls back to replica role when a guard trigger refuses it. */
async function ownerWrite(
  tenantId: string,
  sql: string,
  params: unknown[],
  expectedRows?: number,
) {
  const apply = (replica: boolean) =>
    asOwnerTenant(tenantId, async (client) => {
      if (replica)
        await client.query("SET LOCAL session_replication_role = replica");
      const result = await client.query(sql, params);
      if (expectedRows !== undefined && result.rowCount !== expectedRows)
        throw new Error(`expected ${expectedRows} row(s) from: ${sql}`);
    });
  await apply(false).catch(() => apply(true));
}

/** The edge's own instance id lives on its node row. */
const setInstanceId = (world: World, instanceId: string) =>
  ownerWrite(
    world.tenant.tenantId,
    "UPDATE edge_nodes SET instance_id = $3 WHERE tenant_id = $1 AND id = $2",
    [world.tenant.tenantId, world.node.scope.edgeNodeId, instanceId],
    1,
  ).then(() => {
    world.instanceId = instanceId;
  });

/** What the cloud link does on hello: adopt the edge instance as the active epoch (NULL -> id only). */
const bindEpoch = (world: World) =>
  ownerWrite(
    world.tenant.tenantId,
    `UPDATE sync_cursors SET peer_instance_id = $3
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
        AND peer_instance_id IS NULL`,
    [world.tenant.tenantId, world.node.scope.edgeNodeId, world.instanceId],
  );

/** A fresh outlet with its own primary edge node, so each test starts at zero. */
async function newWorld(tenant: IsolatedTenant): Promise<World> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Rekon', 'Jl. Uji 3', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `R-${randomUUID().slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const registered = await registerEdgeNode(
    contextOf(tenant.tenantId, [outletId]),
    actor,
    { outletId, role: "primary", label: "Utama Rekon" },
  );
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  const world: World = {
    node,
    credential: registered.credential,
    outletId,
    tenant,
    instanceId: randomUUID(),
  };
  await setInstanceId(world, world.instanceId);
  return world;
}

const operator = (world: World) =>
  contextOf(world.tenant.tenantId, [world.outletId]);

let clock = Date.parse("2026-11-10T09:00:00.000Z");
const nextSequence = new Map<string, number>();
/** One edge event, with a per-aggregate gap-free sequence like the real edge. */
function envelope(
  world: World,
  name: string,
  payload: Record<string, unknown>,
  aggregateId = randomUUID(),
): EventEnvelope {
  clock += 1_000;
  const sequence = (nextSequence.get(aggregateId) ?? 0) + 1;
  nextSequence.set(aggregateId, sequence);
  return {
    id: createUlid(clock),
    tenantId: world.tenant.tenantId as EventEnvelope["tenantId"],
    outletId: world.outletId as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0]!,
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:rekon-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    // receiptNumber mirrors the order fixture of edge-order-deferred.test.ts.
    payload: name.startsWith("order.")
      ? { receiptNumber: `LG-${clock}`, ...payload }
      : payload,
  } as EventEnvelope;
}

const J1 = randomUUID();
const J2 = randomUUID();

async function edgeSend(world: World, events: EventEnvelope[]) {
  const context = world.node.context;
  for (const event of events)
    await withTenant(db, context, (tx) =>
      enqueueEdgeEvent(tx, context, {
        edgeNodeId: world.node.scope.edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event,
      }),
    );
}

type EdgeOutbox = { linkSeq: number; event: EventEnvelope }[];
const drainedOutbox = new Map<string, EdgeOutbox>();

/**
 * The edge's queued events, read while the shared cursor row is still unbound.
 * In production the edge and the cloud are separate databases; in this
 * single-database test the edge's own queue rows would make the cloud's
 * sequence check (which also looks at the node's outbound queue) see every
 * applied event as a collision. So the harness reads what the edge queued,
 * keeps it in memory, and then acks + deletes those queue rows (the queue guard
 * refuses deleting pending rows, hence ack first). sync_cursors.next_out_seq is
 * untouched, so the edge digest still reports the same watermark.
 * Returns everything the edge has ever sent, in link order.
 */
async function readEdgeOutbox(world: World): Promise<EdgeOutbox> {
  const nodeId = world.node.scope.edgeNodeId;
  const kept = drainedOutbox.get(nodeId) ?? [];
  drainedOutbox.set(nodeId, kept);
  const last = kept.length > 0 ? kept[kept.length - 1]!.linkSeq : 0;
  const edgeStore = createDbLinkStore({
    database: db,
    context: world.node.context,
    node: world.node.scope,
    outboundDirection: "edge_to_cloud",
    // The shared test DB's cursor may already be bound to this epoch.
    edgeInstanceId: world.instanceId,
  });
  const head = await edgeStore.outboundHead();
  if (head > last) {
    kept.push(...(await edgeStore.readOutbound(last, head - last)));
    await asOwnerTenant(world.tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE edge_outbound_queue SET status = 'acked', acked_at = now()
          WHERE edge_node_id = $1 AND status <> 'acked'`,
        [nodeId],
      );
      await client.query(
        "DELETE FROM edge_outbound_queue WHERE edge_node_id = $1",
        [nodeId],
      );
    });
  }
  return kept;
}

/** The cloud (bound to `edgeInstanceId`, if given) applies the drained outbox, up to `upto`. */
async function cloudReceiveOutbox(
  world: World,
  outbox: EdgeOutbox,
  upto: number | undefined,
  edgeInstanceId?: string,
) {
  const cloudStore = createDbLinkStore({
    database: db,
    context: world.node.context,
    node: world.node.scope,
    outboundDirection: "cloud_to_edge",
    ...(edgeInstanceId ? { edgeInstanceId } : {}),
  });
  const from = await cloudStore.lastReceivedInbound();
  const to = Math.min(upto ?? outbox.length, outbox.length);
  if (to <= from) return;
  await cloudStore.applyInbound({
    fromSeq: from,
    toSeq: to,
    events: outbox.filter((e) => e.linkSeq > from && e.linkSeq <= to),
  });
}

/** The cloud applies what the edge queued, in link order, up to `upto`. */
async function cloudReceive(
  world: World,
  upto?: number,
  edgeInstanceId?: string,
) {
  await cloudReceiveOutbox(
    world,
    await readEdgeOutbox(world),
    upto,
    edgeInstanceId,
  );
}

/** The edge digest; by default the cloud has adopted the edge instance as its epoch (see header). */
async function digestOf(world: World, bind = true): Promise<Digest> {
  const digest = await withTenant(db, world.node.context, (tx) =>
    buildEdgeTxnDigest(tx, world.node.scope),
  );
  if (bind) await bindEpoch(world);
  return digest;
}

/** Emulate "the ledger migration landed after K events were sent": no ledger rows, a baseline row. */
async function wipeLedgerAndSetBaseline(world: World, fromLinkSeq: number) {
  const wipe = async (replica: boolean) =>
    asOwnerTenant(world.tenant.tenantId, async (client) => {
      if (replica)
        await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM edge_txn_ledger WHERE tenant_id = $1 AND edge_node_id = $2",
        [world.tenant.tenantId, world.node.scope.edgeNodeId],
      );
    });
  await wipe(false).catch(() => wipe(true));
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_txn_ledger_baselines (tenant_id, outlet_id, edge_node_id, from_link_seq)
       VALUES ($1, $2, $3, $4)`,
      [
        world.tenant.tenantId,
        world.outletId,
        world.node.scope.edgeNodeId,
        fromLinkSeq,
      ],
    ),
  );
}

const reconcile = (world: World, digest: unknown, context = operator(world)) =>
  reconcileEdgeTransactions(db, context, {
    edgeNodeId: world.node.scope.edgeNodeId,
    digest,
  } as Parameters<typeof reconcileEdgeTransactions>[2]);

/** A typical edge day: a few orders, each submitted, paid, partly refunded/voided. */
function typicalDay(world: World): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (let i = 0; i < 5; i++) {
    const aggregate = randomUUID();
    const total = 50000 + i * 12500;
    events.push(
      envelope(world, "order.submitted", { totalIdr: total }, aggregate),
      envelope(world, "order.paid", { totalIdr: total }, aggregate),
    );
    if (i === 1)
      events.push(
        envelope(world, "order.refunded", { amountIdr: 20000 }, aggregate),
      );
    if (i === 3)
      events.push(
        envelope(world, "order.voided", { amountIdr: total }, aggregate),
      );
  }
  return events;
}

async function runRows(world: World) {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `SELECT id, status, through_link_seq::text AS through_link_seq,
              from_link_seq::text AS from_link_seq, edge_instance_id::text AS edge_instance_id,
              edge_totals, cloud_totals, diffs, checked_at
         FROM edge_reconciliation_runs
        WHERE tenant_id = $1 AND edge_node_id = $2 ORDER BY checked_at, id`,
      [world.tenant.tenantId, world.node.scope.edgeNodeId],
    ),
  );
  return rows as Array<{
    id: string;
    status: string;
    through_link_seq: string;
    from_link_seq: string;
    edge_instance_id: string | null;
    edge_totals: unknown;
    cloud_totals: unknown;
    diffs: unknown;
    checked_at: Date;
  }>;
}

const MONEY_TABLES = [
  "edge_deferred_events",
  "edge_inbound_events",
  "edge_received_events",
  "edge_txn_ledger",
  "edge_txn_ledger_events",
  "edge_outbound_queue",
  "edge_sync_conflicts",
  "sync_cursors",
];

/** Row counts of every tenant table plus content hashes of the money-bearing ones. */
async function snapshot(tenantId: string) {
  return asOwnerTenant(tenantId, async (client) => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );
    const counts: Record<string, number> = {};
    for (const { table_name: name } of tables.rows) {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${name}" WHERE tenant_id::text = $1`,
        [tenantId],
      );
      counts[name] = result.rows[0]!.n;
    }
    const hashes: Record<string, string | null> = {};
    for (const name of MONEY_TABLES) {
      const result = await client.query<{ h: string | null }>(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "${name}" t WHERE t.tenant_id::text = $1`,
        [tenantId],
      );
      hashes[name] = result.rows[0]!.h;
    }
    return { counts, hashes };
  });
}

/** Everything but the reconciliation runs table is exactly as before. */
function expectOnlyRunsChanged(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>,
  newRuns: number,
) {
  const expected = { ...before.counts };
  expected.edge_reconciliation_runs =
    (before.counts.edge_reconciliation_runs ?? 0) + newRuns;
  expect(after.counts).toEqual(expected);
  expect(after.hashes).toEqual(before.hashes);
}

/** The digest the edge would send if it had counted `delta` more/less. */
function tamper(
  digest: Digest,
  name: string,
  change: { count?: number; amount?: bigint; idHash?: bigint },
): Digest {
  const current = digest.totals[name] ?? {
    count: 0,
    amountIdr: "0",
    idHash: "0",
  };
  return {
    ...digest,
    totals: {
      ...digest.totals,
      [name]: {
        count: current.count + (change.count ?? 0),
        amountIdr: (
          BigInt(current.amountIdr) + (change.amount ?? 0n)
        ).toString(),
        // Unless asked, the identity sum is the one the edge really has.
        idHash: (
          (BigInt(current.idHash) + (change.idHash ?? 0n)) %
          TWO_64
        ).toString(),
      },
    },
  };
}

async function member(
  tenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return { client };
}

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, tenantId, name, JSON.stringify(permissions)],
  );
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  resetEdgeApplierRegistryForTests();
  registerPosDeferredEdgeApplier();
  registerEdgeDeferredFallback();
  tenantA = await createIsolatedTenant(`erc-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`erc-b-${randomUUID().slice(0, 6)}`);
  const manage = ["device.registry.manage"];
  const roleA = await insertRole(
    tenantA.tenantId,
    "Pengelola Perangkat",
    manage,
  );
  const plainRole = await insertRole(tenantA.tenantId, "Tanpa Perangkat", [
    "floor.table.view",
  ]);
  const roleB = await insertRole(
    tenantB.tenantId,
    "Pengelola Perangkat",
    manage,
  );
  managerA = await member(
    tenantA,
    roleA,
    { type: "tenant" },
    "Manajer Rekon A",
  );
  managerA1 = await member(
    tenantA,
    roleA,
    { type: "outlet", id: tenantA.outletId },
    "Manajer Outlet Rekon",
  );
  plainA = await member(tenantA, plainRole, { type: "tenant" }, "Tanpa Izin");
  managerB = await member(
    tenantB,
    roleB,
    { type: "tenant" },
    "Manajer Rekon B",
  );
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  // Edge rows are append-only; keep the isolated tenants, give them a valid creator.
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-kai reconcile: ok", () => {
  it("is ok when edge and cloud totals are equal, and persists one run", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    expect(Object.keys(digest.totals).sort()).toEqual([
      "order.paid",
      "order.refunded",
      "order.submitted",
      "order.voided",
    ]);
    const before = await snapshot(world.tenant.tenantId);

    const run = await reconcile(world, digest);
    expect(run.status).toBe("ok");
    const rows = await runRows(world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "ok",
      through_link_seq: String(digest.throughLinkSeq),
      from_link_seq: "0",
      edge_instance_id: world.instanceId,
      edge_totals: digest.totals,
      cloud_totals: digest.totals,
    });
    expect(rows[0]!.diffs).toEqual([]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);
  });

  it("empty state: a node that sent nothing reconciles ok with empty totals", async () => {
    const world = await newWorld(tenantA);
    const digest = await digestOf(world);
    expect(digest.totals).toEqual({});
    expect(digest.throughLinkSeq).toBe(0);
    const run = await reconcile(world, digest);
    expect(run.status).toBe("ok");
    expect((await runRows(world))[0]).toMatchObject({
      edge_totals: {},
      cloud_totals: {},
    });
  });

  it("events after the digest watermark are not counted against it", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    await edgeSend(world, events.slice(0, 6));
    await cloudReceive(world);
    const early = await digestOf(world, false);
    // The edge keeps selling and the cloud keeps receiving after the digest.
    await edgeSend(world, events.slice(6));
    await cloudReceive(world);
    await bindEpoch(world);
    const run = await reconcile(world, early);
    expect(run.status).toBe("ok");
  });

  it("every call appends a run and leaves the earlier runs unchanged", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    await reconcile(world, digest);
    const first = (await runRows(world))[0]!;
    await reconcile(
      world,
      tamper(digest, "order.paid", { count: 1, amount: 100n }),
    );
    const rows = await runRows(world);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(first);
    expect(rows.map((row) => row.status).sort()).toEqual(["mismatch", "ok"]);
  });
});

describe("legend-kai reconcile: mismatch is reported, never fixed", () => {
  it("edge reports more events and rupiah than the cloud received", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const paid = digest.totals["order.paid"]!;
    const before = await snapshot(world.tenant.tenantId);

    const run = await reconcile(
      world,
      tamper(digest, "order.paid", { count: 1, amount: 75000n }),
    );

    expect(run.status).toBe("mismatch");
    const [row] = await runRows(world);
    expect(row!.status).toBe("mismatch");
    expect(row!.diffs).toEqual([
      {
        eventName: "order.paid",
        edgeCount: paid.count + 1,
        cloudCount: paid.count,
        edgeAmountIdr: (BigInt(paid.amountIdr) + 75000n).toString(),
        cloudAmountIdr: paid.amountIdr,
        edgeIdHash: paid.idHash,
        cloudIdHash: paid.idHash,
      },
    ]);
    // Report only: not a single cloud or edge row changed besides the run.
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);
  });

  it("cloud has an extra event the edge digest does not know", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const refunded = digest.totals["order.refunded"]!;
    const run = await reconcile(
      world,
      tamper(digest, "order.refunded", {
        count: -1,
        amount: -BigInt(refunded.amountIdr),
      }),
    );
    expect(run.status).toBe("mismatch");
    expect((await runRows(world))[0]!.diffs).toEqual([
      {
        eventName: "order.refunded",
        edgeCount: refunded.count - 1,
        cloudCount: refunded.count,
        edgeAmountIdr: "0",
        cloudAmountIdr: refunded.amountIdr,
        edgeIdHash: refunded.idHash,
        cloudIdHash: refunded.idHash,
      },
    ]);
  });

  it("same count but one rupiah of difference is a mismatch", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const run = await reconcile(
      world,
      tamper(digest, "order.submitted", { amount: 1n }),
    );
    expect(run.status).toBe("mismatch");
    const diffs = (await runRows(world))[0]!.diffs as Array<
      Record<string, unknown>
    >;
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      eventName: "order.submitted",
      edgeCount: digest.totals["order.submitted"]!.count,
      cloudCount: digest.totals["order.submitted"]!.count,
    });
    expect(diffs[0]!.edgeAmountIdr).not.toBe(diffs[0]!.cloudAmountIdr);
  });

  it("an event name only the edge reports shows with cloud count 0", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world).slice(0, 2));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const run = await reconcile(
      world,
      tamper(digest, "order.refunded", { count: 1, amount: 500n }),
    );
    expect(run.status).toBe("mismatch");
    expect((await runRows(world))[0]!.diffs).toEqual([
      {
        eventName: "order.refunded",
        edgeCount: 1,
        cloudCount: 0,
        edgeAmountIdr: "500",
        cloudAmountIdr: "0",
        edgeIdHash: "0",
        cloudIdHash: "0",
      },
    ]);
  });

  it("totals above 2^53 compare exactly (one rupiah off is still a mismatch)", async () => {
    const world = await newWorld(tenantA);
    const big = 9_000_000_000_000_000;
    await edgeSend(world, [
      envelope(world, "order.paid", { totalIdr: big }),
      envelope(world, "order.paid", { totalIdr: big }),
    ]);
    await cloudReceive(world);
    const digest = await digestOf(world);
    // The two sums (18e15) exceed 2^53; each event (9e15) is itself a safe integer.
    expect(digest.totals["order.paid"]).toMatchObject({
      count: 2,
      amountIdr: "18000000000000000",
    });
    expect(digest.totals["order.paid"]!.idHash).toMatch(/^\d+$/);
    expect((await reconcile(world, digest)).status).toBe("ok");
    expect(
      (await reconcile(world, tamper(digest, "order.paid", { amount: 1n })))
        .status,
    ).toBe("mismatch");
  });

  it("a cloud sum above the bigint range is still recorded as a mismatch (no 500, no lost run)", async () => {
    const world = await newWorld(tenantA);
    const big = "9000000000000000000"; // under 2^63-1 on its own
    const sent = envelope(world, "order.paid", { totalIdr: big });
    await edgeSend(world, [sent]);
    await cloudReceive(world);
    // The cloud also holds a second 9e18 event the edge ledger never counted:
    // its sum (1.8e19) is past 2^63-1.
    const extra = envelope(world, "order.paid", { totalIdr: big });
    const cloudStore = createDbLinkStore({
      database: db,
      context: world.node.context,
      node: world.node.scope,
      outboundDirection: "cloud_to_edge",
      edgeInstanceId: world.instanceId,
    });
    await cloudStore.applyInbound({
      fromSeq: 1,
      toSeq: 2,
      events: [{ linkSeq: 2, event: extra }],
    });
    const digest = await digestOf(world);

    const run = await reconcile(world, { ...digest, throughLinkSeq: 2 });

    expect(run.status).toBe("mismatch");
    expect(run.cloudTotals["order.paid"]).toMatchObject({
      count: 2,
      amountIdr: "18000000000000000000",
    });
    expect((await runRows(world)).map((row) => row.status)).toEqual([
      "mismatch",
    ]);
  });
});

describe("legend-kai reconcile: behind is not a mismatch", () => {
  it("cloud received_in_seq below the digest watermark is behind; once caught up it is ok", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    expect(events.length).toBeGreaterThanOrEqual(8);
    await edgeSend(world, events);
    await cloudReceive(world, 4); // events 5.. are still in flight
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(events.length);
    const before = await snapshot(world.tenant.tenantId);

    const run = await reconcile(world, digest);

    expect(run.status).toBe("behind");
    expect((await runRows(world)).map((row) => row.status)).toEqual(["behind"]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);

    await cloudReceive(world, undefined, world.instanceId);
    const caughtUp = await reconcile(world, digest);
    expect(caughtUp.status).toBe("ok");
  });
});

describe("legend-kai reconcile: mixed traffic", () => {
  it("a stock.moved and an order.item_added travel with the orders; reconcile is still ok", async () => {
    const world = await newWorld(tenantA);
    const orders = typicalDay(world);
    const extras = [
      // Money-looking keys on purpose: the name decides, not the payload.
      envelope(world, "stock.moved", { totalIdr: 999000, amountIdr: 888000 }),
      envelope(world, "order.item_added", {
        totalIdr: 777000,
        amountIdr: 666000,
      }),
    ];
    await edgeSend(world, [
      orders[0]!,
      extras[0]!,
      ...orders.slice(1, 5),
      extras[1]!,
      ...orders.slice(5),
    ]);
    await cloudReceive(world);

    const total = orders.length + extras.length;
    const [inbound] = (
      await asOwnerTenant(world.tenant.tenantId, (client) =>
        client.query(
          "SELECT count(*)::int AS n FROM edge_inbound_events WHERE tenant_id = $1 AND edge_node_id = $2",
          [world.tenant.tenantId, world.node.scope.edgeNodeId],
        ),
      )
    ).rows;
    expect(inbound.n).toBe(total); // the cloud really received them all

    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(total);
    expect(Object.keys(digest.totals).sort()).toEqual([
      "order.paid",
      "order.refunded",
      "order.submitted",
      "order.voided",
    ]);
    const before = await snapshot(world.tenant.tenantId);
    const run = await reconcile(world, digest);
    expect(run.status).toBe("ok");
    const [row] = await runRows(world);
    expect(row!.cloud_totals).toEqual(digest.totals);
    expect(row!.diffs).toEqual([]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);
  });
});

describe("legend-kai reconcile: non-zero peer_seq_offset", () => {
  /** An edge whose database was rebuilt: the cloud already holds 3 events of the old one. */
  async function rebuiltWorld() {
    const world = await newWorld(tenantA);
    // The old edge database sent 3 paid orders (link_seq 1..3). They are in the
    // cloud only: the rebuilt edge's ledger and queue know nothing of them.
    const old = [1, 2, 3].map((i) =>
      envelope(world, "order.paid", { totalIdr: 1_000_000 * i }),
    );
    const cloudOld = createDbLinkStore({
      database: db,
      context: world.node.context,
      node: world.node.scope,
      outboundDirection: "cloud_to_edge",
    });
    await cloudOld.applyInbound({
      fromSeq: 0,
      toSeq: 3,
      events: old.map((event, index) => ({ linkSeq: index + 1, event })),
    });
    const key = [world.tenant.tenantId, world.node.scope.edgeNodeId];
    const cursor = async () =>
      (
        await asOwnerTenant(world.tenant.tenantId, (client) =>
          client.query(
            `SELECT received_in_seq::int AS received_in_seq, peer_seq_offset::int AS peer_seq_offset
               FROM sync_cursors WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
            key,
          ),
        )
      ).rows[0] as { received_in_seq: number; peer_seq_offset: number };
    // The rebase happens after the rebuilt edge queued its events (see
    // readEdgeOutbox): adopt J1, then switch to J2 with offset = received_in_seq.
    const rebase = async () => {
      await asOwnerTenant(world.tenant.tenantId, async (client) => {
        await client.query(
          `UPDATE sync_cursors SET peer_instance_id = $3
            WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
          [...key, J1],
        );
        await client.query(
          `UPDATE sync_cursors SET peer_instance_id = $3, peer_seq_offset = 3
            WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
          [...key, J2],
        );
      });
      expect(await cursor()).toEqual({
        received_in_seq: 3,
        peer_seq_offset: 3,
      });
      // The rebuilt edge database is a new instance: its node row says so.
      await setInstanceId(world, J2);
    };
    return { world, cursor, rebase };
  }

  it("is ok when caught up: only the new instance's window is compared", async () => {
    const { world, cursor, rebase } = await rebuiltWorld();
    await edgeSend(world, typicalDay(world).slice(0, 4)); // edge link_seq 1..4
    const outbox = await readEdgeOutbox(world);
    await rebase();
    await cloudReceiveOutbox(world, outbox, undefined, J2);
    // Cloud numbering is the edge's plus 3 (the 3 old events sit below it).
    expect(await cursor()).toEqual({ received_in_seq: 7, peer_seq_offset: 3 });
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(4);

    const run = await reconcile(world, digest);

    // Old-instance rupiah (6,000,000) must not leak into the cloud totals.
    expect(run.status).toBe("ok");
    expect((await runRows(world))[0]!.cloud_totals).toEqual(digest.totals);
  });

  it("is behind when received_in_seq - offset < through, ok after catching up", async () => {
    const { world, cursor, rebase } = await rebuiltWorld();
    await edgeSend(world, typicalDay(world).slice(0, 4));
    const outbox = await readEdgeOutbox(world);
    await rebase();
    await cloudReceiveOutbox(world, outbox, 2, J2); // only edge events 1..2 arrived
    // Raw received_in_seq (5) already exceeds through (4); minus offset it is 2.
    expect(await cursor()).toEqual({ received_in_seq: 5, peer_seq_offset: 3 });
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(4);

    expect((await reconcile(world, digest)).status).toBe("behind");

    await cloudReceiveOutbox(world, outbox, undefined, J2);
    expect((await reconcile(world, digest)).status).toBe("ok");
  });

  it("still reports a real mismatch inside the window", async () => {
    const { world, rebase } = await rebuiltWorld();
    await edgeSend(world, typicalDay(world).slice(0, 4));
    const outbox = await readEdgeOutbox(world);
    await rebase();
    await cloudReceiveOutbox(world, outbox, undefined, J2);
    const digest = await digestOf(world);
    const run = await reconcile(
      world,
      tamper(digest, "order.paid", { amount: 1n }),
    );
    expect(run.status).toBe("mismatch");
  });

  it("after the rebase a digest of the previous edge instance is stale, the new instance's digest is ok", async () => {
    const { world, rebase } = await rebuiltWorld();
    await edgeSend(world, typicalDay(world).slice(0, 4));
    // Built by the old instance, before the edge database was rebuilt.
    const oldInstance = world.instanceId;
    const oldDigest = await digestOf(world, false);
    expect(oldDigest.edgeInstanceId).toBe(oldInstance);
    const outbox = await readEdgeOutbox(world);
    await rebase();
    await cloudReceiveOutbox(world, outbox, undefined, J2);

    // Same numbers, wrong epoch: applying the new instance's offset to the old
    // instance's digest would be a false answer either way.
    const stale = await reconcile(world, oldDigest);
    expect(stale.status).toBe("stale");
    const fresh = await digestOf(world);
    expect(fresh.edgeInstanceId).toBe(J2);
    expect(fresh.totals).toEqual(oldDigest.totals);
    expect((await reconcile(world, fresh)).status).toBe("ok");
    const rows = await runRows(world);
    expect(rows.map((row) => row.status)).toEqual(["stale", "ok"]);
    expect(rows.map((row) => row.edge_instance_id)).toEqual([oldInstance, J2]);
  });
});

describe("legend-kai reconcile: ledger added mid-life (baseline)", () => {
  const SENT_BEFORE = 6; // typicalDay()[0..5]; the rest is sent with the ledger live

  it("a digest of a node without a baseline row reports fromLinkSeq 0", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world).slice(0, 2));
    expect((await digestOf(world)).fromLinkSeq).toBe(0);
  });

  it("baseline = events sent before the ledger: only later events are compared, status ok", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    await edgeSend(world, events.slice(0, SENT_BEFORE));
    await wipeLedgerAndSetBaseline(world, SENT_BEFORE);
    await cloudReceive(world); // the cloud counts all K pre-ledger events
    await edgeSend(world, events.slice(SENT_BEFORE));
    await cloudReceive(world);

    const digest = await digestOf(world);
    expect(digest.fromLinkSeq).toBe(SENT_BEFORE);
    expect(digest.throughLinkSeq).toBe(events.length);
    // The edge ledger knows only the post-baseline events.
    const lateOnly = events.slice(SENT_BEFORE);
    expect(digest.totals["order.paid"]?.count ?? 0).toBe(
      lateOnly.filter((e) => e.name === "order.paid").length,
    );

    const run = await reconcile(world, digest);
    expect(run.status).toBe("ok");
    const [row] = await runRows(world);
    expect(row!.diffs).toEqual([]);
    expect(row!.cloud_totals).toEqual(digest.totals);
    // The run remembers the window it judged: from, through and the epoch.
    expect(row).toMatchObject({
      from_link_seq: String(SENT_BEFORE),
      through_link_seq: String(events.length),
      edge_instance_id: world.instanceId,
    });
  });

  it("the same scenario with baseline 0 is a mismatch (the baseline is what makes it ok)", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    await edgeSend(world, events.slice(0, SENT_BEFORE));
    await wipeLedgerAndSetBaseline(world, 0); // wrongly claims nothing was sent before
    await cloudReceive(world);
    await edgeSend(world, events.slice(SENT_BEFORE));
    await cloudReceive(world);

    const digest = await digestOf(world);
    expect(digest.fromLinkSeq).toBe(0);
    const run = await reconcile(world, digest);
    expect(run.status).toBe("mismatch");
    expect(
      ((await runRows(world))[0]!.diffs as unknown[]).length,
    ).toBeGreaterThan(0);
  });

  it("empty window: fromLinkSeq equal to throughLinkSeq with no totals reconciles ok", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    await edgeSend(world, events);
    await wipeLedgerAndSetBaseline(world, events.length);
    await cloudReceive(world);
    const digest = await digestOf(world);
    expect(digest.fromLinkSeq).toBe(events.length);
    expect(digest.throughLinkSeq).toBe(events.length);
    expect(digest.totals).toEqual({});
    expect((await reconcile(world, digest)).status).toBe("ok");
  });

  it("a digest with fromLinkSeq above throughLinkSeq is refused and writes nothing", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const bad = { ...digest, fromLinkSeq: digest.throughLinkSeq + 1 };
    const before = await snapshot(world.tenant.tenantId);

    const error = await reconcile(world, bad).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(TypeError);
    const { code, status } = error as { code?: unknown; status?: unknown };
    expect(
      typeof code === "string" || (typeof status === "number" && status < 500),
    ).toBe(true);
    expect(await runRows(world)).toEqual([]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 0);

    const response = await managerA.client
      .post(
        `/api/edge-nodes/${encodeURIComponent(world.node.scope.edgeNodeId)}/reconciliation`,
      )
      .set({ Host: tenantA.hostname })
      .set(originHeader)
      .send(bad);
    expect([400, 422]).toContain(response.status);
    expect(await runRows(world)).toEqual([]);
  });
});

describe("legend-kai reconcile: hostile totals keys", () => {
  const HOSTILE = ["toString", "__proto__", "constructor", "hasOwnProperty"];
  /** JSON text with the key as an own property (an object literal would not keep __proto__). */
  const rawBody = (digest: Digest, key: string) =>
    `{"edgeNodeId":"${digest.edgeNodeId}","edgeInstanceId":"${digest.edgeInstanceId}","fromLinkSeq":${digest.fromLinkSeq},"throughLinkSeq":${digest.throughLinkSeq},"totals":{${JSON.stringify(key)}:{"count":1,"amountIdr":"1","idHash":"1"}}}`;
  const digestWithKey = (digest: Digest, key: string): Digest =>
    ({
      ...digest,
      totals: JSON.parse(rawBody(digest, key)).totals,
    }) as Digest;

  it("the service refuses them with a clean error and writes nothing", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const before = await snapshot(world.tenant.tenantId);
    for (const key of HOSTILE) {
      const error = await reconcile(world, digestWithKey(digest, key)).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, key).not.toBeNull();
      expect(error, key).not.toBeInstanceOf(TypeError);
      const { code, status } = error as { code?: unknown; status?: unknown };
      expect(
        typeof code === "string" ||
          (typeof status === "number" && status < 500),
        key,
      ).toBe(true);
    }
    expect(await runRows(world)).toEqual([]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 0);
  });

  it("the route answers 4xx, never 500, and writes nothing", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    const url = `/api/edge-nodes/${encodeURIComponent(world.node.scope.edgeNodeId)}/reconciliation`;
    for (const key of HOSTILE) {
      const response = await managerA.client
        .post(url)
        .set({ Host: tenantA.hostname })
        .set(originHeader)
        .set("Content-Type", "application/json")
        .send(rawBody(digest, key));
      expect([400, 422], key).toContain(response.status);
    }
    expect(await runRows(world)).toEqual([]);
  });
});

describe("legend-kai reconcile: tenant and outlet isolation", () => {
  it("tenant B cannot reconcile or read tenant A's node; nothing is written", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    await reconcile(world, digest); // one legitimate run as tenant A
    const before = await snapshot(world.tenant.tenantId);

    const asB = contextOf(tenantB.tenantId, "tenant");
    await expect(
      reconcileEdgeTransactions(db, asB, {
        edgeNodeId: world.node.scope.edgeNodeId,
        digest,
      } as Parameters<typeof reconcileEdgeTransactions>[2]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const listed = await listEdgeReconciliationRuns(db, asB, {
      edgeNodeId: world.node.scope.edgeNodeId,
      limit: 20,
    }).then(
      (value) => value,
      (error: { code?: string }) => {
        expect(error.code).toBe("NOT_FOUND");
        return [];
      },
    );
    expect(
      Array.isArray(listed) ? listed : (listed as { items: unknown[] }).items,
    ).toEqual([]);

    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 0);
    const runsOfB = await asOwnerTenant(tenantB.tenantId, (client) =>
      client.query(
        "SELECT 1 FROM edge_reconciliation_runs WHERE tenant_id = $1",
        [tenantB.tenantId],
      ),
    );
    expect(runsOfB.rows).toEqual([]);
  });

  it("an operator scoped to another outlet cannot reconcile this node", async () => {
    const world = await newWorld(tenantA);
    const digest = await digestOf(world);
    const otherOutlet = contextOf(tenantA.tenantId, [tenantA.outletId]);
    await expect(reconcile(world, digest, otherOutlet)).rejects.toThrow();
    expect(await runRows(world)).toEqual([]);
  });

  it("lists the node's runs for an in-scope operator, honouring the limit", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world);
    await reconcile(world, digest);
    await reconcile(world, tamper(digest, "order.paid", { count: 1 }));
    const asList = (limit: number) =>
      listEdgeReconciliationRuns(db, operator(world), {
        edgeNodeId: world.node.scope.edgeNodeId,
        limit,
      }).then((value) =>
        Array.isArray(value) ? value : (value as { items: unknown[] }).items,
      );
    expect(await asList(10)).toHaveLength(2);
    expect(await asList(1)).toHaveLength(1);
  });
});

describe("legend-kai reconciliation route", () => {
  const path = (world: World) =>
    `/api/edge-nodes/${encodeURIComponent(world.node.scope.edgeNodeId)}/reconciliation`;
  const post = (
    who: Member,
    tenant: IsolatedTenant,
    url: string,
    body: unknown,
  ) =>
    who.client
      .post(url)
      .set({ Host: tenant.hostname })
      .set(originHeader)
      .send(body as object);
  const get = (who: Member, tenant: IsolatedTenant, url: string) =>
    who.client.get(url).set({ Host: tenant.hostname }).set(originHeader);
  const rowsOf = (data: unknown) =>
    Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);

  async function readyWorld() {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    return { world, digest: await digestOf(world) };
  }

  it("legend-e3k4p the edge posts its own digest using only its bearer credential", async () => {
    const { world, digest } = await readyWorld();
    const before = await snapshot(tenantA.tenantId);
    // No session, Origin or tenant hostname: identity comes from the edge credential.
    const response = await agent(app)
      .post(path(world))
      .set("Authorization", `Bearer ${world.credential}`)
      .send(digest);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      edgeNodeId: world.node.scope.edgeNodeId,
      tenantId: tenantA.tenantId,
      outletId: world.outletId,
      checkedBy: null,
      status: "ok",
    });
    expectOnlyRunsChanged(before, await snapshot(tenantA.tenantId), 1);
  });

  it.each(["same tenant", "other tenant"])(
    "legend-e3k4p a credential cannot submit to another node in the %s",
    async (location) => {
      const { world } = await readyWorld();
      const other = await newWorld(
        location === "same tenant" ? tenantA : tenantB,
      );
      const digest = await digestOf(other);
      const beforeOwn = await runRows(world);
      const beforeOther = await runRows(other);
      // Both URL and digest point to the victim, so only the credential can reject this.
      const response = await agent(app)
        .post(path(other))
        .set("Authorization", `Bearer ${world.credential}`)
        .send(digest);
      expect([403, 404]).toContain(response.status);
      expect(await runRows(world)).toEqual(beforeOwn);
      expect(await runRows(other)).toEqual(beforeOther);
    },
  );

  it("legend-e3k4p the digest body cannot override the credential node", async () => {
    const { world } = await readyWorld();
    const other = await newWorld(tenantA);
    const response = await agent(app)
      .post(path(world))
      .set("Authorization", `Bearer ${world.credential}`)
      .send(await digestOf(other));
    expect([400, 403, 404, 422]).toContain(response.status);
    expect(await runRows(world)).toEqual([]);
    expect(await runRows(other)).toEqual([]);
  });

  it("legend-e3k4p a malformed bearer is refused and cannot read operator run history", async () => {
    const { world, digest } = await readyWorld();
    const refused = await agent(app)
      .post(path(world))
      .set("Authorization", "Bearer invalid-edge-credential")
      .send(digest);
    expect(refused.status).toBe(401);
    const history = await agent(app)
      .get(path(world))
      .set("Authorization", `Bearer ${world.credential}`);
    expect([401, 403, 404]).toContain(history.status);
    expect(await runRows(world)).toEqual([]);
  });

  it("legend-e3k4p a valid credential cannot use another tenant domain", async () => {
    const { world, digest } = await readyWorld();
    const response = await agent(app)
      .post(path(world))
      .set("Host", tenantB.hostname)
      .set("Authorization", `Bearer ${world.credential}`)
      .send(digest);
    expect([403, 404]).toContain(response.status);
    expect(await runRows(world)).toEqual([]);
  });

  it("legend-e3k4p a revoked credential cannot submit a reconciliation report", async () => {
    const { world, digest } = await readyWorld();
    await revokeEdgeNode(operator(world), actor, {
      edgeNodeId: world.node.scope.edgeNodeId,
      reason: "Credential revoked before the scheduled report",
    });
    const response = await agent(app)
      .post(path(world))
      .set("Authorization", `Bearer ${world.credential}`)
      .send(digest);
    expect(response.status).toBe(401);
    expect(await runRows(world)).toEqual([]);
  });

  it("a permitted operator posts a digest and reads the run back", async () => {
    const { world, digest } = await readyWorld();
    const response = await post(managerA, tenantA, path(world), digest);
    expect([200, 201]).toContain(response.status);
    const window = {
      fromLinkSeq: digest.fromLinkSeq,
      throughLinkSeq: digest.throughLinkSeq,
      edgeInstanceId: digest.edgeInstanceId,
    };
    expect(response.body.data).toMatchObject({ status: "ok", ...window });
    const listed = await get(managerA, tenantA, `${path(world)}?limit=5`);
    expect(listed.status).toBe(200);
    expect(rowsOf(listed.body.data)).toHaveLength(1);
    expect(rowsOf(listed.body.data)[0]).toMatchObject({
      status: "ok",
      ...window,
    });
  });

  it("a digest of another edge instance is reported as stale (a check, not an error)", async () => {
    const { world, digest } = await readyWorld();
    const foreign = randomUUID();
    const response = await post(managerA, tenantA, path(world), {
      ...digest,
      edgeInstanceId: foreign,
    });
    expect([200, 201]).toContain(response.status);
    expect(response.body.data).toMatchObject({
      status: "stale",
      edgeInstanceId: foreign,
      fromLinkSeq: digest.fromLinkSeq,
      throughLinkSeq: digest.throughLinkSeq,
    });
    const listed = await get(managerA, tenantA, path(world));
    expect(rowsOf(listed.body.data)[0]).toMatchObject({
      status: "stale",
      edgeInstanceId: foreign,
    });
  });

  it("a mismatch is reported to the operator as a successful check", async () => {
    const { world, digest } = await readyWorld();
    const response = await post(
      managerA,
      tenantA,
      path(world),
      tamper(digest, "order.paid", { count: 1, amount: 1000n }),
    );
    expect([200, 201]).toContain(response.status);
    expect(response.body.data).toMatchObject({ status: "mismatch" });
  });

  it("answers 401 without a session", async () => {
    const { world, digest } = await readyWorld();
    const anonymous = agent(app);
    const posted = await anonymous
      .post(path(world))
      .set({ Host: tenantA.hostname })
      .set(originHeader)
      .send(digest);
    expect(posted.status).toBe(401);
    const listed = await anonymous
      .get(path(world))
      .set({ Host: tenantA.hostname })
      .set(originHeader);
    expect(listed.status).toBe(401);
    expect(await runRows(world)).toEqual([]);
  });

  it("refuses a POST from an untrusted origin", async () => {
    const { world, digest } = await readyWorld();
    const response = await managerA.client
      .post(path(world))
      .set({ Host: tenantA.hostname })
      .set({ Origin: "https://evil.example" })
      .send(digest);
    expect(response.status).toBe(403);
    expect(await runRows(world)).toEqual([]);
  });

  // Assumption: like the existing edge-node routes (edge-link-hardening-2.test.ts),
  // a signed-in user without the permission gets 403 or 404 (the node's existence
  // is not revealed); either is a refusal.
  it("refuses a signed-in user without device.registry.manage (403 or 404)", async () => {
    const { world, digest } = await readyWorld();
    expect([403, 404]).toContain(
      (await post(plainA, tenantA, path(world), digest)).status,
    );
    expect([403, 404]).toContain(
      (await get(plainA, tenantA, path(world))).status,
    );
    expect(await runRows(world)).toEqual([]);
  });

  it("refuses an operator limited to another outlet", async () => {
    const { world, digest } = await readyWorld();
    expect([403, 404]).toContain(
      (await post(managerA1, tenantA, path(world), digest)).status,
    );
    expect([403, 404]).toContain(
      (await get(managerA1, tenantA, path(world))).status,
    );
    expect(await runRows(world)).toEqual([]);
  });

  it("answers 404 to another tenant's operator and writes nothing", async () => {
    const { world, digest } = await readyWorld();
    const posted = await post(managerB, tenantB, path(world), digest);
    expect([403, 404]).toContain(posted.status);
    const listed = await get(managerB, tenantB, path(world));
    expect([403, 404]).toContain(listed.status);
    expect(await runRows(world)).toEqual([]);
  });

  it("rejects an invalid digest body with 4xx and writes nothing", async () => {
    const { world, digest } = await readyWorld();
    const bad: unknown[] = [
      {},
      { ...digest, extra: "nope" }, // strict: unknown keys refused
      { ...digest, throughLinkSeq: -1 },
      { ...digest, throughLinkSeq: 1.5 },
      { ...digest, fromLinkSeq: -1 },
      { ...digest, fromLinkSeq: 0.5 },
      { ...digest, fromLinkSeq: digest.throughLinkSeq + 1 },
      { ...digest, totals: { "order.paid": { count: -1, amountIdr: "1000" } } },
      { ...digest, totals: { "order.paid": { count: 1, amountIdr: "12.5" } } },
      { ...digest, totals: { "order.paid": { count: 1, amountIdr: "-1" } } },
      { ...digest, totals: { "order.paid": { count: 1, amountIdr: "abc" } } },
      { ...digest, totals: { "order.paid": { count: 1 } } },
      { ...digest, edgeNodeId: "not-a-uuid" },
      { ...digest, edgeNodeId: randomUUID() }, // not the node in the path
      // Epoch and identity fields are required and strict.
      { ...digest, edgeInstanceId: undefined },
      { ...digest, edgeInstanceId: "not-a-uuid" },
      { ...digest, edgeInstanceId: null },
      { ...digest, totals: { "order.paid": { count: 1, amountIdr: "1" } } },
      {
        ...digest,
        totals: { "order.paid": { count: 1, amountIdr: "1", idHash: "x1" } },
      },
      {
        ...digest,
        totals: { "order.paid": { count: 1, amountIdr: "1", idHash: "-1" } },
      },
      {
        ...digest,
        totals: {
          "order.paid": {
            count: 1,
            amountIdr: "1",
            idHash: TWO_64.toString(), // one above the 64-bit range
          },
        },
      },
      // Rupiah above the bigint range (30 digits was accepted before).
      {
        ...digest,
        totals: {
          "order.paid": {
            count: 1,
            amountIdr: (MAX_BIGINT + 1n).toString(),
            idHash: "1",
          },
        },
      },
      {
        ...digest,
        totals: {
          "order.paid": {
            count: 1,
            amountIdr: "1".repeat(30),
            idHash: "1",
          },
        },
      },
    ];
    for (const body of bad) {
      const response = await post(managerA, tenantA, path(world), body);
      expect([400, 422], JSON.stringify(body)).toContain(response.status);
    }
    expect(await runRows(world)).toEqual([]);
  });

  it("rejects a malformed edge node id in the path", async () => {
    const { digest } = await readyWorld();
    const response = await post(
      managerA,
      tenantA,
      "/api/edge-nodes/not-a-uuid/reconciliation",
      digest,
    );
    expect([400, 404, 422]).toContain(response.status);
  });
});

describe("legend-kai reconcile: stale epoch (digest of another edge instance)", () => {
  async function ready() {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    return { world, digest: await digestOf(world) };
  }

  it("a digest whose edge instance is not the active epoch is stale: no comparison, run keeps the window and epoch", async () => {
    const { world, digest } = await ready();
    const foreign = randomUUID();
    const before = await snapshot(world.tenant.tenantId);

    const run = await reconcile(world, { ...digest, edgeInstanceId: foreign });

    expect(run.status).toBe("stale");
    const rows = await runRows(world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "stale",
      from_link_seq: String(digest.fromLinkSeq),
      through_link_seq: String(digest.throughLinkSeq),
      edge_instance_id: foreign,
      cloud_totals: {},
      diffs: [],
    });
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);
    // The right instance with the same numbers is ok: the epoch alone decided.
    expect((await reconcile(world, digest)).status).toBe("ok");
  });

  it("stale is judged first: a digest of another instance is not mismatch and not behind", async () => {
    const world = await newWorld(tenantA);
    const events = typicalDay(world);
    await edgeSend(world, events);
    await cloudReceive(world, 4); // the cloud is behind the watermark...
    const digest = await digestOf(world);
    const foreign = randomUUID();

    // ...which would be "behind" for the right instance, "mismatch" for tampered numbers.
    expect((await reconcile(world, digest)).status).toBe("behind");
    expect(
      (await reconcile(world, { ...digest, edgeInstanceId: foreign })).status,
    ).toBe("stale");
    await cloudReceive(world, undefined, world.instanceId);
    expect(
      (
        await reconcile(
          world,
          tamper({ ...digest, edgeInstanceId: foreign }, "order.paid", {
            count: 3,
            amount: 99n,
          }),
        )
      ).status,
    ).toBe("stale");
    const stale = (await runRows(world)).filter((r) => r.status === "stale");
    expect(stale).toHaveLength(2);
    for (const row of stale) {
      expect(row.cloud_totals).toEqual({});
      expect(row.diffs).toEqual([]);
    }
  });

  it("while the cloud has not adopted any edge instance (peer_instance_id NULL) every digest is stale", async () => {
    const world = await newWorld(tenantA);
    await edgeSend(world, typicalDay(world));
    await cloudReceive(world);
    const digest = await digestOf(world, false);
    expect((await reconcile(world, digest)).status).toBe("stale");
    await bindEpoch(world);
    expect((await reconcile(world, digest)).status).toBe("ok");
  });
});

describe("legend-kai reconcile: event identity, not only count and rupiah", () => {
  async function sendThree() {
    const world = await newWorld(tenantA);
    const sent = [1, 2, 3].map(() =>
      envelope(world, "order.paid", { totalIdr: 5000 }),
    );
    await edgeSend(world, sent);
    return { world, sent };
  }

  it("one event lost and another of the same rupiah in its place keeps count and sum equal, yet is a mismatch", async () => {
    const { world, sent } = await sendThree();
    const outbox = await readEdgeOutbox(world);
    clock += 1_000;
    const stranger: EventEnvelope = {
      ...sent[2]!,
      id: createUlid(clock),
      idempotencyKey: `order.paid:rekon-stranger-${clock}`,
    };
    // The cloud received e1, e2 and a different event instead of e3.
    const received = outbox.map((entry) =>
      entry.linkSeq === 3 ? { ...entry, event: stranger } : entry,
    );
    await cloudReceiveOutbox(world, received, undefined);
    const digest = await digestOf(world);
    expect(digest.totals["order.paid"]).toMatchObject({
      count: 3,
      amountIdr: "15000",
    });
    const before = await snapshot(world.tenant.tenantId);

    const run = await reconcile(world, digest);

    expect(run.status).toBe("mismatch");
    const cloudHash =
      (eventIdentityHash(sent[0]!.id) +
        eventIdentityHash(sent[1]!.id) +
        eventIdentityHash(stranger.id)) %
      TWO_64;
    const edgeHash =
      (eventIdentityHash(sent[0]!.id) +
        eventIdentityHash(sent[1]!.id) +
        eventIdentityHash(sent[2]!.id)) %
      TWO_64;
    expect(digest.totals["order.paid"]!.idHash).toBe(edgeHash.toString());
    expect((await runRows(world))[0]!.diffs).toEqual([
      {
        eventName: "order.paid",
        edgeCount: 3,
        cloudCount: 3,
        edgeAmountIdr: "15000",
        cloudAmountIdr: "15000",
        edgeIdHash: edgeHash.toString(),
        cloudIdHash: cloudHash.toString(),
      },
    ]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 1);
  });

  it("an idHash that differs by one with equal count and rupiah is a mismatch with both hashes in the diff", async () => {
    const { world } = await sendThree();
    await cloudReceive(world);
    const digest = await digestOf(world);
    const paid = digest.totals["order.paid"]!;
    const run = await reconcile(
      world,
      tamper(digest, "order.paid", { idHash: 1n }),
    );
    expect(run.status).toBe("mismatch");
    expect((await runRows(world))[0]!.diffs).toEqual([
      {
        eventName: "order.paid",
        edgeCount: 3,
        cloudCount: 3,
        edgeAmountIdr: "15000",
        cloudAmountIdr: "15000",
        edgeIdHash: ((BigInt(paid.idHash) + 1n) % TWO_64).toString(),
        cloudIdHash: paid.idHash,
      },
    ]);
  });
});

describe("legend-kai reconcile: bigint bounds", () => {
  // Money above 2^53 travels as a canonical digit string in the event payload.
  const NEAR_MAX_STRING = "9223372036854774784"; // 2^63 - 1024

  async function maxWorld() {
    const world = await newWorld(tenantA);
    await edgeSend(world, [
      envelope(world, "order.paid", { totalIdr: NEAR_MAX_STRING }),
      envelope(world, "order.paid", { totalIdr: 1023 }),
    ]);
    await cloudReceive(world);
    return { world, digest: await digestOf(world) };
  }

  it("a total of exactly 9223372036854775807 rupiah reconciles ok, exact on both sides", async () => {
    const { world, digest } = await maxWorld();
    expect(digest.totals["order.paid"]!.amountIdr).toBe(MAX_BIGINT.toString());
    const run = await reconcile(world, digest);
    expect(run.status).toBe("ok");
    expect(
      (await runRows(world))[0]!.cloud_totals as Record<string, unknown>,
    ).toEqual(digest.totals);
  });

  it("one rupiah above the range is refused by the service and the route, nothing written", async () => {
    const { world, digest } = await maxWorld();
    const over = {
      ...digest,
      totals: {
        "order.paid": {
          ...digest.totals["order.paid"]!,
          amountIdr: (MAX_BIGINT + 1n).toString(),
        },
      },
    };
    const before = await snapshot(world.tenant.tenantId);
    const error = await reconcile(world, over).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(TypeError);
    const { code, status } = error as { code?: unknown; status?: unknown };
    expect(
      typeof code === "string" || (typeof status === "number" && status < 500),
    ).toBe(true);
    const response = await managerA.client
      .post(
        `/api/edge-nodes/${encodeURIComponent(world.node.scope.edgeNodeId)}/reconciliation`,
      )
      .set({ Host: tenantA.hostname })
      .set(originHeader)
      .send(over);
    expect([400, 422]).toContain(response.status);
    expect(await runRows(world)).toEqual([]);
    expectOnlyRunsChanged(before, await snapshot(world.tenant.tenantId), 0);
  });
});
