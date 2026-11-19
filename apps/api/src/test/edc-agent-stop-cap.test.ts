// legend-1ffe (bundle 1158, card 2): EDC agent `stop(ctx)` must not wait
// forever for in-flight terminal calls; it gives up after a time cap and logs
// a warning.
//
// Source of truth: bead legend-1ffe ("stop()/releaseOutlet drains every
// tracked terminal call with no timeout. Add cap + logged warning"). The
// terminal call stays tracked after the sale timeout when the terminal ignores
// the abort (simulator `ignore_abort`, EDC-03), which is the stuck call used
// here. Real disposable PostgreSQL, in-memory ECR simulator as bank adapter.
//
// Assumptions (spec silent on names/values; recorded here and in the report):
// - The cap is configured through a new `createEdcAgent` option
//   `stopTimeoutMs` (milliseconds). Its default is not asserted.
// - After the cap, `stop(ctx)` RESOLVES (never rejects) but the per-outlet
//   lock stays held while the stuck call is pending (round 2): a second agent
//   cannot claim the outlet and its sale is not sent. When the call settles
//   the lock is released in the background and a second agent can claim.
// - The warning goes through the shared pino `logger` of lib/logger (the
//   logger itself or a child), at any level, and its text mentions one of
//   stop / shutdown / drain / in-flight. No such line is written when the
//   in-flight call settles inside the cap or nothing is in flight.
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
import { createEdcAgent } from "../edge/edc/agent.ts";
import { ensureBill } from "./edc-agent-bill-helper.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { logger } from "../lib/logger.ts";
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
let tenant: IsolatedTenant;
let cashier: string;

const AMOUNT = 55_000;
const refOf = () => `STP-${randomUUID().slice(0, 8)}`;
const STOP_LOG = /stop|shut\s?down|drain|in-?flight/i;

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

async function staffUser(label: string): Promise<string> {
  const client = httpAgent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, tenant.tenantId, label, JSON.stringify(["pos.payment.accept"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return userId;
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

type Agent = ReturnType<typeof createEdcAgent>;
const started: Array<{ agent: Agent; ctx: ScopedTenantContext }> = [];

// A fresh simulator, terminal and agent. `stopTimeoutMs` is the new option.
async function fixture(options: {
  ignoreAbortDelayMs?: number;
  stopTimeoutMs?: number;
}) {
  const sim = new EcrSimulator("bca", {
    ...(options.ignoreAbortDelayMs !== undefined
      ? { ignoreAbortDelayMs: options.ignoreAbortDelayMs }
      : {}),
  });
  const registry = new EdcProviderRegistry().register(sim);
  const terminalId = await seedTerminal();
  const c = ctx();
  const agent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
    ...(options.stopTimeoutMs !== undefined
      ? { stopTimeoutMs: options.stopTimeoutMs }
      : {}),
  } as Parameters<typeof createEdcAgent>[0]);
  started.push({ agent, ctx: c });
  await agent.start(c);
  return { ctx: c, agent, sim, terminalId };
}

// Leaves a terminal call in flight: the sale times out (answer `unknown`) but
// the terminal ignores the abort, so the agent still tracks the call.
async function leaveCallInFlight(f: Awaited<ReturnType<typeof fixture>>) {
  f.sim.next(f.terminalId, "ignore_abort");
  const req = {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId: f.terminalId,
    reference: refOf(),
    idempotencyKey: randomUUID(),
    amountIdr: idr(AMOUNT),
    method: "card",
  } as EdcPaymentRequest;
  await ensureBill(owner, req);
  const tx = await f.agent.requestPayment(f.ctx, cashier, req);
  expect(tx.status).toBe("unknown");
  expect(f.sim.callsFor(f.terminalId).sale).toBe(1);
}

// Second agent on the same DB for the same outlet. Own simulator, so
// `saleCalls` shows whether a sale reached a terminal through it.
// Assumption: a failed lock claim is refused with an error (from `start` or,
// if claiming is lazy, from `requestPayment`); the exact message is not asserted.
async function tryClaimAndSell(): Promise<{
  agent: Agent | null;
  error: unknown;
  saleCalls: number;
}> {
  const sim = new EcrSimulator("bca");
  const c = ctx();
  const candidate = createEdcAgent({
    db,
    registry: new EdcProviderRegistry().register(sim),
    saleTimeoutMs: 1_000,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  const terminalId = await seedTerminal();
  let error: unknown;
  try {
    await candidate.start(c);
    const req = {
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      outletId: outletIdSchema.parse(tenant.outletId),
      terminalId,
      reference: refOf(),
      idempotencyKey: randomUUID(),
      amountIdr: idr(AMOUNT),
      method: "card",
    } as EdcPaymentRequest;
    await ensureBill(owner, req);
    await candidate.requestPayment(c, cashier, req);
  } catch (caught) {
    error = caught;
  }
  let saleCalls = 0;
  try {
    saleCalls = sim.callsFor(terminalId).sale;
  } catch {
    // Terminal never reached through this simulator.
  }
  if (error === undefined) {
    started.push({ agent: candidate, ctx: c });
    return { agent: candidate, error, saleCalls };
  }
  await candidate.stop(c).catch(() => undefined);
  return { agent: null, error, saleCalls };
}

function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    for (const arg of args) {
      try {
        lines.push(
          typeof arg === "string"
            ? arg
            : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {})),
        );
      } catch {
        lines.push(String(arg));
      }
    }
  };
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const spyLevels = (target: Record<string, unknown>) => {
    for (const level of levels)
      if (typeof target[level] === "function")
        vi.spyOn(
          target as Record<string, (...a: unknown[]) => unknown>,
          level,
        ).mockImplementation((...args: unknown[]) => record(...args));
  };
  spyLevels(logger as unknown as Record<string, unknown>);
  const originalChild = logger.child.bind(logger);
  vi.spyOn(logger, "child").mockImplementation(((...args: unknown[]) => {
    const child = (originalChild as (...a: unknown[]) => unknown)(...args);
    spyLevels(child as Record<string, unknown>);
    return child;
  }) as unknown as typeof logger.child);
  return lines;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`edc-stp-${randomUUID().slice(0, 6)}`);
  cashier = await staffUser("EDC Stop Kasir");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { agent, ctx: c } of started.splice(0))
    await agent.stop(c).catch(() => undefined);
});

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-1ffe EDC agent stop() time cap", () => {
  it("legend-1ffe stop returns at the cap and warns, but keeps the outlet locked until the stuck call settles", async () => {
    // The terminal ignores the abort and settles only ~3 s after it.
    const f = await fixture({ ignoreAbortDelayMs: 3_000, stopTimeoutMs: 150 });
    await leaveCallInFlight(f);

    const lines = captureLogs();
    const startedAt = Date.now();
    await f.agent.stop(f.ctx);
    const elapsed = Date.now() - startedAt;
    // Without a cap stop waits for the full ~3 s; the cap is 150 ms.
    expect(elapsed).toBeLessThan(2_000);
    expect(lines.some((line) => STOP_LOG.test(line))).toBe(true);

    // The terminal call is still live, so the outlet must stay locked: a second
    // agent on the same DB cannot take it and its sale never reaches a terminal.
    const blocked = await tryClaimAndSell();
    expect(blocked.agent).toBeNull();
    expect(blocked.error).toBeDefined();
    expect(blocked.saleCalls).toBe(0);

    // Once the stuck call settles the lock is released in the background and a
    // second agent can claim the outlet and sell.
    await vi.waitFor(
      async () => {
        const claimed = await tryClaimAndSell();
        expect(claimed.error).toBeUndefined();
        expect(claimed.saleCalls).toBe(1);
      },
      { timeout: 15_000, interval: 250 },
    );
  }, 40_000);

  it("legend-1ffe stop still waits for a call that settles inside the cap, without a warning", async () => {
    const f = await fixture({ ignoreAbortDelayMs: 300, stopTimeoutMs: 5_000 });
    await leaveCallInFlight(f);

    const lines = captureLogs();
    const startedAt = Date.now();
    await f.agent.stop(f.ctx);
    expect(Date.now() - startedAt).toBeLessThan(4_500);
    expect(lines.filter((line) => STOP_LOG.test(line))).toEqual([]);
  }, 20_000);

  it("legend-1ffe stop with nothing in flight returns at once and does not warn", async () => {
    const f = await fixture({ stopTimeoutMs: 150 });
    const lines = captureLogs();
    const startedAt = Date.now();
    await f.agent.stop(f.ctx);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(lines.filter((line) => STOP_LOG.test(line))).toEqual([]);
  }, 20_000);
});
