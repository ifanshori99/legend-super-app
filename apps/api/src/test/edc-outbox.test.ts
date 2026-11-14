// EDC ledger -> outbox (bead legend-apt, EDC-05): every ledger status change
// writes its `edc_transaction.*` event in the same database transaction.
// Real disposable PostgreSQL, in-memory ECR simulator as the bank adapter.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EdcPaymentRequest } from "@starter/shared/edc";
import type { EventEnvelope } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  createLinkPeer,
  type LinkPeer,
  type LinkStore,
} from "../edge/link-peer.ts";
import { decodeFrame } from "../edge/protocol.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
} from "../services/edge-node.service.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { emitEdcTransactionEvent } from "../edge/edc/events.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { agent as httpAgent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const app = createApp();
const AMOUNT = 55_000;
let tenant: IsolatedTenant;
let cashier: string;

const ctx = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function seedTerminal(): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-TEST', 'Test EDC', 'lan', '10.0.0.5', $5, 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        `TID-${id.slice(0, 8)}`,
        ["card", "qris"],
      ],
    ),
  );
  return id;
}

async function eventsOf(
  aggregateId: string,
): Promise<Array<{ name: string; sequence: number; status: string }>> {
  return asOwner(async (client) => {
    const result = await client.query<{
      name: string;
      sequence: string;
      payload: { status: string };
    }>(
      `SELECT event->>'name' AS name, sequence, event->'payload' AS payload
       FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2
       ORDER BY sequence`,
      [tenant.tenantId, aggregateId],
    );
    return result.rows.map((r) => ({
      name: r.name,
      sequence: Number(r.sequence),
      status: r.payload.status,
    }));
  });
}

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];
afterEach(async () => {
  for (const { agent, ctx: c } of started.splice(0))
    await agent.stop(c).catch(() => undefined);
});

async function setup() {
  const sim = new EcrSimulator("bca");
  const registry = new EdcProviderRegistry();
  registry.register(sim);
  const terminalId = await seedTerminal();
  const c = ctx();
  const agent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  started.push({ agent, ctx: c });
  await agent.start(c);
  const request = (): EdcPaymentRequest =>
    ({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      outletId: outletIdSchema.parse(tenant.outletId),
      terminalId,
      reference: `BILL-${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
      amountIdr: idr(AMOUNT),
      method: "card",
    }) as EdcPaymentRequest;
  return { sim, agent, ctx: c, terminalId, request };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`edc-o-${randomUUID().slice(0, 6)}`);
  const client = httpAgent(app);
  await signUp(client, "EDC Outbox Kasir");
  const session = await client.get("/api/auth/get-session");
  cashier = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'EDC Outbox', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(["pos.payment.accept"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, cashier, roleId],
  );
});

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("EDC outbox (EDC-05)", () => {
  it("an approved sale writes created then approved, in order", async () => {
    const f = await setup();
    const tx = await f.agent.requestPayment(f.ctx, cashier, f.request());
    expect(tx.status).toBe("approved");
    expect(await eventsOf(tx.id)).toEqual([
      { name: "edc_transaction.created", sequence: 1, status: "pending" },
      { name: "edc_transaction.approved", sequence: 2, status: "approved" },
    ]);
  });

  it("EDC-05 card and QRIS payments recorded offline survive store recreation and sync once after reconnect", async () => {
    const f = await setup();
    const registered = await registerEdgeNode(f.ctx, cashier, {
      outletId: tenant.outletId,
      role: "primary",
      label: "EDC offline sync",
    });
    const node = await authenticateEdgeCredential(registered.credential);
    expect(node).not.toBeNull();
    const storeOptions = {
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud" as const,
    };
    const offlineStore = createDbLinkStore(storeOptions);
    // No link peers exist while the cafe internet is down. The ECR simulator
    // represents the bank terminal on the outlet LAN, independent of that link.
    const cardRequest = f.request();
    const qrisRequest = { ...f.request(), method: "qris" as const };
    const card = await f.agent.requestPayment(f.ctx, cashier, cardRequest);
    const qris = await f.agent.requestPayment(f.ctx, cashier, qrisRequest);
    expect([card.status, qris.status]).toEqual(["approved", "approved"]);
    expect([card.method, qris.method]).toEqual(["card", "qris"]);
    expect([card.amountIdr, qris.amountIdr]).toEqual([AMOUNT, AMOUNT]);
    expect(f.sim.chargedCount(f.terminalId)).toBe(2);

    const emitted = await asOwner(async (client) => {
      const result = await client.query<{ event: EventEnvelope }>(
        `SELECT event FROM domain_event_outbox
         WHERE tenant_id = $1 AND aggregate_id = ANY($2::uuid[])
         ORDER BY aggregate_id, sequence`,
        [tenant.tenantId, [card.id, qris.id]],
      );
      return result.rows.map((row) => row.event);
    });
    expect(emitted).toHaveLength(4);
    // Feed the real ledger's outbox events into the durable edge queue. This
    // exercises the store/link boundary; automatic outbox routing is separate.
    await withTenant(db, f.ctx, async (tx) => {
      for (const event of emitted)
        await enqueueEdgeEvent(tx, f.ctx, {
          edgeNodeId: node!.scope.edgeNodeId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event,
        });
    });
    expect(await offlineStore.lastAckedOutbound()).toBe(0);
    expect(
      (await offlineStore.readOutbound(0, 10)).map((e) => e.event),
    ).toEqual(emitted);

    // Recreate the sender: queued payment evidence and its cursor come from
    // PostgreSQL rather than a surviving in-memory peer. As in edge-db.test.ts,
    // record cloud delivery in a separate store: sharing the sender's database
    // would also share its pre-existing aggregate history.
    const edgeStore = createDbLinkStore(storeOptions);
    const applied: EventEnvelope[] = [];
    let receivedCursor = 0;
    const cloudStore: LinkStore = {
      outboundHead: async () => 0,
      lastAckedOutbound: async () => 0,
      readOutbound: async () => [],
      ackOutbound: async () => {},
      lastReceivedInbound: async () => receivedCursor,
      applyInbound: async ({ fromSeq, toSeq, events }) => {
        if (fromSeq !== receivedCursor) throw new Error("Cloud cursor moved");
        applied.push(...events.map(({ event }) => event));
        receivedCursor = toSeq;
      },
    };
    expect(await cloudStore.lastReceivedInbound()).toBe(0);
    let droppedAck = false;
    let duplicatedBatch = false;
    const edgePeer: LinkPeer = createLinkPeer({
      scope: node!.scope,
      outboundDirection: "edge_to_cloud",
      store: edgeStore,
      version: "edge",
      ackTimeoutMs: 50,
      transport: {
        send(data) {
          queueMicrotask(() => {
            cloudPeer.receive(data);
            if (decodeFrame(data)?.type === "batch") {
              duplicatedBatch = true;
              cloudPeer.receive(data);
            }
          });
        },
        close() {},
      },
    });
    const cloudPeer: LinkPeer = createLinkPeer({
      scope: node!.scope,
      outboundDirection: "cloud_to_edge",
      store: cloudStore,
      version: "cloud",
      ackTimeoutMs: 50,
      transport: {
        send(data) {
          if (!droppedAck && decodeFrame(data)?.type === "ack") {
            droppedAck = true;
            return;
          }
          queueMicrotask(() => edgePeer.receive(data));
        },
        close() {},
      },
    });
    try {
      edgePeer.start();
      cloudPeer.start();
      await vi.waitFor(
        async () => expect(await edgeStore.lastAckedOutbound()).toBe(4),
        { timeout: 5000 },
      );
      expect(droppedAck).toBe(true);
      expect(duplicatedBatch).toBe(true);
      expect(applied).toEqual(emitted);
      const approvals = applied.filter(
        (event) => event.name === "edc_transaction.approved",
      );
      expect(approvals.map((event) => event.aggregateId).sort()).toEqual(
        [card.id, qris.id].sort(),
      );
      expect(approvals.map((event) => event.payload.amountIdr)).toEqual([
        AMOUNT,
        AMOUNT,
      ]);
      expect(await cloudStore.lastReceivedInbound()).toBe(4);
      expect(await edgeStore.readOutbound(4, 10)).toEqual([]);
      const replayCard = await f.agent.requestPayment(
        f.ctx,
        cashier,
        cardRequest,
      );
      const replayQris = await f.agent.requestPayment(
        f.ctx,
        cashier,
        qrisRequest,
      );
      expect([replayCard.id, replayQris.id]).toEqual([card.id, qris.id]);
      expect([replayCard.amountIdr, replayQris.amountIdr]).toEqual([
        AMOUNT,
        AMOUNT,
      ]);
      expect(f.sim.chargedCount(f.terminalId)).toBe(2);
      expect(await eventsOf(card.id)).toHaveLength(2);
      expect(await eventsOf(qris.id)).toHaveLength(2);
    } finally {
      edgePeer.stop();
      cloudPeer.stop();
    }
  });

  it("a declined sale writes created then declined", async () => {
    const f = await setup();
    f.sim.next(f.terminalId, "decline");
    const tx = await f.agent.requestPayment(f.ctx, cashier, f.request());
    expect((await eventsOf(tx.id)).map((e) => e.name)).toEqual([
      "edc_transaction.created",
      "edc_transaction.declined",
    ]);
  });

  it("a rolled-back ledger write leaves no outbox row", async () => {
    const f = await setup();
    const tx = await f.agent.requestPayment(f.ctx, cashier, f.request());
    const before = await eventsOf(tx.id);
    await expect(
      withTenant(db, f.ctx, async (dbTx) => {
        const [row] = await dbTx
          .update(edcTransactions)
          .set({ message: "rolled back" })
          .where(eq(edcTransactions.id, tx.id))
          .returning();
        await emitEdcTransactionEvent(dbTx, f.ctx, {
          name: "edc_transaction.flagged",
          row: row!,
          now: new Date(),
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(await eventsOf(tx.id)).toEqual(before);
    const [stored] = await asOwner(
      async (client) =>
        (
          await client.query<{ message: string | null }>(
            "SELECT message FROM edc_transactions WHERE id = $1",
            [tx.id],
          )
        ).rows,
    );
    expect(stored!.message).not.toBe("rolled back");
  });
});
