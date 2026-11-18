// legend-1rfy7 (fail-first, second-opinion F2): building the edge reconciliation
// digest locks the edge_to_cloud sync cursor row (FOR UPDATE). When another
// local transaction holds that row, the digest build must not wait forever: it
// must give up on abort or on a lock timeout, roll back, and reject quickly.
//
// Declared seam (does not exist yet, so these tests fail first because the
// export is missing): services/edge-txn-ledger.service.ts exports
//   buildEdgeTxnDigestBounded(database, context, scope, { signal, lockTimeoutMs })
// which is buildEdgeTxnDigest inside withTenant with SET LOCAL lock_timeout and
// statement_timeout, rejecting when `signal` aborts. Context and scope are the
// authenticated edge node's `context` and `scope`.
// Assumptions: the exact rejection type is not pinned (any rejection counts);
// a signal already aborted rejects without waiting; the digest build never
// POSTs, so "no POST" is covered by the sender test.
import { randomUUID } from "node:crypto";
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
import * as ledger from "../services/edge-txn-ledger.service.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const actor = randomUUID();
let tenant: IsolatedTenant;

type BoundedBuild = (
  database: typeof db,
  context: ScopedTenantContext,
  scope: AuthenticatedEdgeNode["scope"],
  options: { signal?: AbortSignal; lockTimeoutMs?: number },
) => Promise<{ throughLinkSeq: number }>;

function bounded(): BoundedBuild {
  const seam = (ledger as Record<string, unknown>).buildEdgeTxnDigestBounded;
  expect(
    typeof seam,
    "services/edge-txn-ledger.service.ts must export buildEdgeTxnDigestBounded",
  ).toBe("function");
  return seam as BoundedBuild;
}

const contextOf = (
  tenantId: string,
  outletIds: string[],
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

/** The edge's own instance id lives on its node row (a fresh row has none). */
async function setInstanceId(edgeNodeId: string) {
  const apply = async (replica: boolean) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      if (replica)
        await client.query("SET LOCAL session_replication_role = replica");
      const result = await client.query(
        "UPDATE edge_nodes SET instance_id = $3 WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, edgeNodeId, randomUUID()],
      );
      if (result.rowCount !== 1) throw new Error("edge node row not found");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await apply(false).catch(() => apply(true));
}

/** A fresh outlet with its own primary edge node and an existing edge_to_cloud cursor. */
async function newWorld() {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Lock', 'Jl. Uji 3', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `K-${randomUUID().slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const registered = await registerEdgeNode(
    contextOf(tenant.tenantId, [outletId]),
    actor,
    { outletId, role: "primary", label: "Utama Lock" },
  );
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  await setInstanceId(node.scope.edgeNodeId);
  // One queued event creates the edge_to_cloud cursor row the digest locks.
  const at = Date.now();
  const event = {
    id: createUlid(at),
    tenantId: tenant.tenantId,
    outletId,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(at).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `order.paid:lock-${at}`,
    payloadSchemaRef: "order.paid.v1",
    payload: { totalIdr: 10_000 },
  } as unknown as EventEnvelope;
  await withTenant(db, node.context, (tx) =>
    enqueueEdgeEvent(tx, node.context, {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
      event,
    }),
  );
  return node;
}

/** Holds the node's edge_to_cloud cursor row FOR UPDATE until released. */
async function holdCursor(edgeNodeId: string) {
  const blocker = await owner.connect();
  await blocker.query("BEGIN");
  const pid = (
    await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  const locked = await blocker.query(
    `SELECT 1 FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'edge_to_cloud' FOR UPDATE`,
    [edgeNodeId],
  );
  if (locked.rowCount !== 1) throw new Error("edge_to_cloud cursor missing");
  return { blocker, pid };
}

async function release(blocker: PoolClient) {
  await blocker.query("ROLLBACK").catch(() => undefined);
  blocker.release();
}

const waiters = async (pid: number) =>
  (
    await owner.query(
      `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [pid],
    )
  ).rowCount!;

async function waitUntilBlocked(pid: number) {
  for (let n = 0; n < 200; n++) {
    if ((await waiters(pid)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The digest build never waited on the cursor lock");
}

async function waitUntilFree(pid: number) {
  for (let n = 0; n < 100; n++) {
    if ((await waiters(pid)) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Settles with the call's outcome, or "hung" so a missing bound fails fast. */
async function settleWithin(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  const outcome = promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
  try {
    return await Promise.race([outcome, hung]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`edl-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  setAuditWriter(null);
  // Edge rows are append-only, so the isolated tenant stays in the disposable
  // database; give it a valid creator so the platform tenant list parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-1rfy7 digest build against a held sync cursor", () => {
  it("aborting the signal rolls the build back and rejects quickly", async () => {
    const build = bounded();
    const node = await newWorld();
    const { blocker, pid } = await holdCursor(node.scope.edgeNodeId);
    try {
      const controller = new AbortController();
      const call = build(db, node.context, node.scope, {
        signal: controller.signal,
        lockTimeoutMs: 60_000,
      });
      await waitUntilBlocked(pid);
      const startedAt = Date.now();
      controller.abort();
      expect(await settleWithin(call, 3_000)).toBe("rejected");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // The waiting backend is gone, not abandoned on the lock queue.
      expect(await waitUntilFree(pid)).toBe(true);
    } finally {
      await release(blocker);
    }
  }, 20_000);

  it("a short lock timeout rejects the build instead of waiting for the holder", async () => {
    const build = bounded();
    const node = await newWorld();
    const { blocker, pid } = await holdCursor(node.scope.edgeNodeId);
    try {
      const startedAt = Date.now();
      const call = build(db, node.context, node.scope, { lockTimeoutMs: 200 });
      expect(await settleWithin(call, 5_000)).toBe("rejected");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await waitUntilFree(pid)).toBe(true);
    } finally {
      await release(blocker);
    }
  }, 20_000);

  it("a signal that is already aborted rejects without waiting on the lock", async () => {
    const build = bounded();
    const node = await newWorld();
    const { blocker } = await holdCursor(node.scope.edgeNodeId);
    try {
      const call = build(db, node.context, node.scope, {
        signal: AbortSignal.abort(),
        lockTimeoutMs: 60_000,
      });
      expect(await settleWithin(call, 3_000)).toBe("rejected");
    } finally {
      await release(blocker);
    }
  }, 20_000);

  it("after an aborted attempt the cursor is not left locked and the next build succeeds", async () => {
    const build = bounded();
    const node = await newWorld();
    const { blocker, pid } = await holdCursor(node.scope.edgeNodeId);
    try {
      const controller = new AbortController();
      const call = build(db, node.context, node.scope, {
        signal: controller.signal,
        lockTimeoutMs: 60_000,
      });
      await waitUntilBlocked(pid);
      controller.abort();
      expect(await settleWithin(call, 3_000)).toBe("rejected");
    } finally {
      await release(blocker);
    }
    const digest = await build(db, node.context, node.scope, {
      lockTimeoutMs: 5_000,
    });
    expect(digest.throughLinkSeq).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
