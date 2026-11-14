// Regression tests for the Codex second-opinion findings 1-3 on the EDC agent
// (docs/briefs/102-fix-edc-codex.md). Real disposable PostgreSQL, in-memory ECR
// simulator as the bank adapter.
//
// 1. An inquiry `not_found` that echoes another transaction's trace is not an
//    answer for this row: it may never turn the row into `failed`.
// 2. After `stop()` an old operation must not send a sale next to a
//    replacement agent: stop waits for it, and it re-checks ownership.
// 3. (TID/MID/IP replaced under an unfinished sale) is closed in the admin
//    service: see "EDC-07 a terminal's identity cannot change..." in
//    payment-admin-api.test.ts.
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
import {
  ecrInquiryResultSchema,
  type EdcPaymentRequest,
  type EdcProvider,
} from "@starter/shared/edc";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent, type EdcAgentDeps } from "../edge/edc/agent.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { ensureBill } from "./edc-agent-bill-helper.ts";
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
const refOf = () => `CDX-${randomUUID().slice(0, 8)}`;

const ctx: () => ScopedTenantContext = () =>
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

type Row = {
  id: string;
  status: string;
  reference: string;
  trace: string;
  needs_reconciliation: boolean;
  dispatched_at: Date | null;
};

async function rowsFor(reference: string): Promise<Row[]> {
  return asOwner(async (client) => {
    const result = await client.query<Row>(
      `SELECT id, status, reference, trace, needs_reconciliation, dispatched_at
       FROM edc_transactions
       WHERE tenant_id = $1 AND reference = $2
       ORDER BY created_at, id`,
      [tenant.tenantId, reference],
    );
    return result.rows;
  });
}

type Agent = ReturnType<typeof createEdcAgent>;

const started: Array<{ agent: Agent; ctx: ScopedTenantContext }> = [];

afterEach(async () => {
  for (const { agent, ctx: c } of started.splice(0))
    await agent.stop(c).catch(() => undefined);
});

type Fixture = {
  ctx: ScopedTenantContext;
  actor: string;
  bca: EcrSimulator;
  terminalId: string;
  agent: Agent;
  /** Another agent on the same simulator, not started. */
  makeAgent: () => Agent;
};

/** One terminal, a fresh simulator and a started agent per test. */
async function fixture(
  options: {
    saleTimeoutMs?: number;
    wrap?: (sim: EcrSimulator) => EdcProvider;
    deps?: Partial<EdcAgentDeps>;
  } = {},
): Promise<Fixture> {
  const sim = new EcrSimulator("bca");
  const registry = new EdcProviderRegistry().register(
    options.wrap ? options.wrap(sim) : sim,
  );
  const terminalId = await seedTerminal();
  const c = ctx();
  const makeAgent = () => {
    const created = createEdcAgent({
      db,
      registry,
      saleTimeoutMs: options.saleTimeoutMs ?? 50,
      inquiryTimeoutMs: 50,
      cancelTimeoutMs: 50,
      notFoundGraceMs: 0,
      ...options.deps,
    });
    started.push({ agent: created, ctx: c });
    return created;
  };
  const agent = makeAgent();
  await agent.start(c);
  return { ctx: c, actor: cashier, bca: sim, terminalId, agent, makeAgent };
}

function request(
  f: Fixture,
  over: Partial<EdcPaymentRequest> = {},
): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId: f.terminalId,
    reference: refOf(),
    idempotencyKey: randomUUID(),
    amountIdr: idr(AMOUNT),
    method: "card",
    ...over,
  } as EdcPaymentRequest;
}

const pay = async (f: Fixture, req: EdcPaymentRequest) => {
  await ensureBill(owner, req);
  return f.agent.requestPayment(f.ctx, f.actor, req);
};

const refTo = (id: string) => ({
  tenantId: tenantIdSchema.parse(tenant.tenantId),
  outletId: outletIdSchema.parse(tenant.outletId),
  transactionId: id,
});

const passThrough = (
  sim: EcrSimulator,
  over: Partial<EdcProvider> = {},
): EdcProvider => ({
  bank: sim.bank,
  capabilities: sim.capabilities,
  sale: (r) => sim.sale(r),
  cancel: (r) => sim.cancel(r),
  inquiry: (r) => sim.inquiry(r),
  void: (r) => sim.void(r),
  ...over,
});

/** Same batch at dispatch and at inquiry, and the sale is old enough. */
async function makeNotFoundTrustable(id: string): Promise<void> {
  await asOwner((client) =>
    client.query(
      `UPDATE edc_transactions
       SET dispatched_at = now() - interval '1 minute', dispatch_batch_no = '000001'
       WHERE id = $1`,
      [id],
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`edc-cx-${randomUUID().slice(0, 6)}`);
  cashier = await staffUser("EDC Codex Kasir");
});

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("Codex finding 1: not_found must echo this row's trace", () => {
  it("C1 a not_found that carries another transaction's trace is ignored: the row stays unknown and the re-bill is refused", async () => {
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          // The terminal answers for transaction B (same batch), not for A.
          inquiry: async () =>
            ecrInquiryResultSchema.parse({
              outcome: "not_found",
              trace: "OTHERTRACE1",
              batchNo: "000001",
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge"); // A charged, answer lost
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    await makeNotFoundTrustable(tx.id);

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect((await rowsFor(first.reference)).map((r) => r.status)).toEqual([
      "unknown",
    ]);

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });
});

describe("Codex finding 2: ownership is checked before the sale goes out", () => {
  it("C2 stop() while a sale waits for the terminal, plus a replacement agent: only one sale reaches the terminal", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    const replacement = f.makeAgent();

    f.bca.next(f.terminalId, "hold"); // sale X sits at the terminal
    const heldReq = request(f);
    const held = pay(f, heldReq);
    let heldTrace = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(heldReq.reference);
      expect(rows).toHaveLength(1);
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      heldTrace = rows[0]!.trace;
    });

    // Sale Y is written and queued behind X: not on the wire yet.
    const queuedReq = request(f);
    const queued = pay(f, queuedReq).then(
      () => "sent",
      (error: unknown) => error,
    );
    await vi.waitFor(async () => {
      expect(await rowsFor(queuedReq.reference)).toHaveLength(1);
    });

    const stopping = f.agent.stop(f.ctx);
    // The old operation is still alive, so the outlet is not free yet.
    const early = await replacement.start(f.ctx).then(
      () => "started",
      () => "refused",
    );
    expect(early).toBe("refused");

    f.bca.complete(f.terminalId, heldTrace, "approve");
    await held;
    expect(await queued).toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    await stopping;

    // Y never reached the terminal, under either agent.
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);

    // The replacement takes over once the old agent let go.
    await replacement.start(f.ctx);
    const nextReq = request(f);
    await ensureBill(owner, nextReq);
    const next = await replacement.requestPayment(f.ctx, f.actor, nextReq);
    expect(next.status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).sale).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Round 2 (architect review of the fixes above)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An open row already handed to the terminal, as left by a crashed agent. */
async function seedUnknown(
  f: Fixture,
  reference = refOf(),
): Promise<{ id: string; trace: string; reference: string }> {
  const id = randomUUID();
  const trace = `S${id.replace(/-/g, "").slice(0, 11)}`;
  await asOwner((client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace, dispatched_at,
          dispatch_batch_no)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-test', 55000, 'card', 'unknown', $7,
               now(), '000001')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        f.terminalId,
        reference,
        randomUUID(),
        trace,
      ],
    ),
  );
  return { id, trace, reference };
}

/** Sale X sits at the terminal; resolves once it is on the wire. */
async function holdSale(
  f: Fixture,
): Promise<{ done: Promise<unknown>; id: string; trace: string }> {
  f.bca.next(f.terminalId, "hold");
  const req = request(f);
  const done = pay(f, req);
  let found = { id: "", trace: "" };
  await vi.waitFor(async () => {
    const rows = await rowsFor(req.reference);
    expect(rows).toHaveLength(1);
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    found = { id: rows[0]!.id, trace: rows[0]!.trace };
  });
  return { done, ...found };
}

describe("Round 2 finding 1: ownership is checked before every terminal call", () => {
  it("R1a an inquiry queued behind a sale does not reach the terminal after stop()", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    const open = await seedUnknown(f);
    const x = await holdSale(f);
    const inquiring = f.agent.inquire(f.ctx, f.actor, refTo(open.id)).then(
      () => "answered",
      (error: unknown) => error,
    );
    await sleep(100); // queued behind X
    const stopping = f.agent.stop(f.ctx);
    f.bca.complete(f.terminalId, x.trace, "approve");
    await x.done;
    expect(await inquiring).toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    await stopping;
    expect(f.bca.callsFor(f.terminalId).inquiry).toBe(0);
  });

  it("R1b a cancel queued behind a sale does not reach the terminal after stop()", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    const open = await seedUnknown(f);
    const x = await holdSale(f);
    const cancelling = f.agent.cancel(f.ctx, f.actor, refTo(open.id)).then(
      () => "answered",
      (error: unknown) => error,
    );
    await sleep(100);
    const stopping = f.agent.stop(f.ctx);
    f.bca.complete(f.terminalId, x.trace, "approve");
    await x.done;
    expect(await cancelling).toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    await stopping;
    expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
  });

  it("R1c a bypass cancel of the sale on the wire is refused once ownership is gone", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    const x = await holdSale(f);
    // Same tick: stop() takes the outlet away while the cancel loads its row.
    const cancelling = f.agent.cancel(f.ctx, f.actor, refTo(x.id)).then(
      () => "answered",
      (error: unknown) => error,
    );
    const stopping = f.agent.stop(f.ctx);
    expect(await cancelling).toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
    f.bca.complete(f.terminalId, x.trace, "approve");
    await x.done;
    await stopping;
  });

  it("R1d the inquiry inside the retry guard is refused once ownership is gone", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    const open = await seedUnknown(f);
    const x = await holdSale(f);
    // A retry for the open reference inquires it first, queued behind X.
    const retry = pay(f, request(f, { reference: open.reference })).then(
      () => "sent",
      (error: unknown) => error,
    );
    await sleep(100);
    const stopping = f.agent.stop(f.ctx);
    f.bca.complete(f.terminalId, x.trace, "approve");
    await x.done;
    await retry;
    await stopping;
    expect(f.bca.callsFor(f.terminalId).inquiry).toBe(0);
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
  });
});

describe("Round 2 finding 2: stop() waits for every call on the wire", () => {
  it("R2a a sale call that outlived its timeout holds the outlet until it settles", async () => {
    let release = () => {};
    const f = await fixture({
      saleTimeoutMs: 50,
      wrap: (sim) =>
        passThrough(sim, {
          sale: () =>
            new Promise((_, reject) => {
              release = () => reject(new Error("late"));
            }),
        }),
    });
    const tx = await pay(f, request(f));
    expect(tx.status).toBe("unknown");
    let stopped = false;
    const stopping = f.agent.stop(f.ctx).then(() => {
      stopped = true;
    });
    try {
      await sleep(100);
      expect(stopped).toBe(false);
      const early = await f
        .makeAgent()
        .start(f.ctx)
        .then(
          () => "started",
          () => "refused",
        );
      expect(early).toBe("refused");
    } finally {
      release();
    }
    await stopping;
    expect(stopped).toBe(true);
  });

  it("R2b a bypass cancel still on the wire holds the outlet until it settles", async () => {
    let release = () => {};
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrap: (sim) =>
        passThrough(sim, {
          cancel: () =>
            new Promise((_, reject) => {
              release = () => reject(new Error("late"));
            }),
        }),
    });
    const x = await holdSale(f);
    await f.agent.cancel(f.ctx, f.actor, refTo(x.id)); // times out at 50 ms
    f.bca.complete(f.terminalId, x.trace, "approve");
    await x.done;
    let stopped = false;
    const stopping = f.agent.stop(f.ctx).then(() => {
      stopped = true;
    });
    try {
      await sleep(100);
      expect(stopped).toBe(false);
    } finally {
      release();
    }
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("Round 2 finding 3: the terminal config is read where the row is written", () => {
  it("R3 a TID changed after the first read but before the write-ahead is what the sale uses", async () => {
    const holder: { fx?: Fixture } = {};
    const seen: string[] = [];
    const open = { trace: "", id: "" };
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          // Resolving the earlier attempt lets the retry go on; meanwhile the
          // admin swaps the terminal's TID.
          inquiry: async () => {
            await asOwner((client) =>
              client.query(
                "UPDATE payment_edc_terminals SET terminal_id = 'TID-CHANGED' WHERE id = $1",
                [holder.fx!.terminalId],
              ),
            );
            return ecrInquiryResultSchema.parse({
              outcome: "declined",
              trace: open.trace,
            });
          },
          sale: (r) => {
            seen.push(r.terminal.terminalId);
            return sim.sale(r);
          },
        }),
    });
    holder.fx = f;
    const earlier = await seedUnknown(f);
    open.trace = earlier.trace;
    open.id = earlier.id;
    const tx = await pay(f, request(f, { reference: earlier.reference }));
    expect(tx.status).toBe("approved");
    expect(seen).toEqual(["TID-CHANGED"]);
  });
});

describe("Round 2 finding 4: a sale refused at the last check is marked not sent", () => {
  it("R4 ownership lost between the dispatch claim and the wire leaves a failed, undispatched row", async () => {
    let armed = false;
    let calls = 0;
    const holder: { fx?: Fixture } = {};
    const f = await fixture({
      deps: {
        // After the trace is drawn, the next `now()` is the write-ahead and
        // the one after it is the dispatch claim: stop() lands there.
        newTrace: () => {
          armed = true;
          calls = 0;
          return `R4${randomUUID().replace(/-/g, "").slice(0, 10)}`;
        },
        now: () => {
          if (armed && (calls += 1) === 2) {
            armed = false;
            void holder.fx!.agent.stop(holder.fx!.ctx);
          }
          return new Date();
        },
      },
    });
    holder.fx = f;
    const req = request(f);
    await expect(pay(f, req)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    const [row] = await rowsFor(req.reference);
    expect(row).toMatchObject({ status: "failed", dispatched_at: null });
  });
});

describe("Round 3 finding 1: card data is filtered when a row is read", () => {
  it("X3a get, inquire and an idempotent replay never return a legacy PAN-like cardType or reference", async () => {
    const f = await fixture();
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("approved");
    await asOwner((client) =>
      client.query(
        `UPDATE edc_transactions
         SET card_type = '4111111111111111', rrn = '4111111111111111',
             invoice_no = 'A4111111111111111', batch_no = '4111111111111111XY'
         WHERE id = $1`,
        [tx.id],
      ),
    );
    const reads = [
      await f.agent.get(f.ctx, f.actor, refTo(tx.id)),
      await f.agent.inquire(f.ctx, f.actor, refTo(tx.id)),
      await pay(f, req),
    ];
    for (const read of reads) {
      expect(read.cardType).toBe("UNKNOWN");
      expect(read.rrn).toBeNull();
      expect(read.invoiceNo).toBeNull();
      expect(read.batchNo).toBeNull();
      expect(JSON.stringify(read)).not.toMatch(/\d{13}/);
    }
  });
});

describe("Round 3 finding 2: a not_found without a trace settles nothing", () => {
  it("X3b a trace-less not_found keeps the row unknown and the re-bill refused", async () => {
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async () =>
            ecrInquiryResultSchema.parse({
              outcome: "not_found",
              batchNo: "000001",
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    await makeNotFoundTrustable(tx.id);

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("X3c the simulator echoes the trace on not_found, so the normal resolution still works", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_before_charge"); // never reached the bank
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    await makeNotFoundTrustable(tx.id);
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("failed");
  });
});
