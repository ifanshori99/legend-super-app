// EDC ledger -> outbox (bead legend-apt, EDC-05): every ledger status change
// writes its `edc_transaction.*` event in the same database transaction.
// Real disposable PostgreSQL, in-memory ECR simulator as the bank adapter.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
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
      [id, tenant.tenantId, tenant.outletId, `TID-${id.slice(0, 8)}`, ["card"]],
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
