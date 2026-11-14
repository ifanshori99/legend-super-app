// Regression tests for the EDC review K findings (ws/edc-framework, brief
// docs/briefs/sub-edc-review-k.md section T). Written to the brief, not to the
// implementation: they are expected to fail until fixes A1/A2/A3/A6/B5 land.
// Real disposable PostgreSQL, in-memory ECR simulator as the bank adapter.
//
// Invariant for every money test: the simulator never charges one reference
// twice (`chargedCount` stays 1 for the reference's terminal).
//
// Assumptions (brief silent, also in the report):
// - A1: a refused retry writes no new ledger row and sends no new sale.
// - A1b: the retry for an in-flight reference goes to a second terminal of the
//   same outlet, so the answer cannot depend on the terminal queue.
// - A2 default window is 15 minutes (`notFoundTrustWindowMs`); "older" in the
//   tests is 1 hour, "inside" is 1 minute.
// - A3 stuck terminal: cancel is rejected with EDC_TERMINAL_UNAVAILABLE (the
//   reason the agent already uses for a stuck terminal).
// - A3 busy terminal: "goes through the queue" means no terminal `cancel`
//   call while another exchange holds the terminal. The "still not called"
//   check waits a fixed 300 ms; it can only pass wrongly, never fail wrongly.
// - A6: a second start() on a started agent may resolve or throw; only the
//   live row must stay untouched.
// - B5: production is detected through `env.isProduction` of config/env.ts
//   (and process.env.NODE_ENV); both are faked, the registry must throw.
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
  ecrResultSchema,
  type EcrSaleRequest,
  type EdcPaymentRequest,
  type EdcProvider,
} from "@starter/shared/edc";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
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
const refOf = () => `REV-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  message: string | null;
  needs_reconciliation: boolean;
  dispatched_at: Date | null;
};

async function rowsFor(reference: string): Promise<Row[]> {
  return asOwner(async (client) => {
    const result = await client.query<Row>(
      `SELECT id, status, reference, trace, message, needs_reconciliation, dispatched_at
       FROM edc_transactions
       WHERE tenant_id = $1 AND reference = $2
       ORDER BY created_at, id`,
      [tenant.tenantId, reference],
    );
    return result.rows;
  });
}

/** A ledger row written directly, as left by an earlier attempt. */
async function insertRow(
  terminalId: string,
  row: {
    reference: string;
    status:
      "pending" | "unknown" | "approved" | "cancelled" | "failed" | "declined";
    needsReconciliation?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const final = !["pending", "unknown"].includes(row.status);
  await asOwner((client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace, completed_at,
          dispatched_at, needs_reconciliation)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-test', $7, 'card', $8::varchar, $9,
               CASE WHEN $10::boolean THEN now() ELSE NULL END, now(), $11)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalId,
        row.reference,
        randomUUID(),
        AMOUNT,
        row.status,
        `T${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        final,
        row.needsReconciliation ?? false,
      ],
    ),
  );
  return id;
}

const ageDispatch = (id: string, interval: string) =>
  asOwner((client) =>
    client.query(
      `UPDATE edc_transactions SET dispatched_at = now() - $2::interval WHERE id = $1`,
      [id, interval],
    ),
  );

type Fixture = {
  ctx: ScopedTenantContext;
  actor: string;
  bca: EcrSimulator;
  terminalId: string;
  agent: ReturnType<typeof createEdcAgent>;
};

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];

afterEach(async () => {
  for (const { agent, ctx: c } of started.splice(0))
    await agent.stop(c).catch(() => undefined);
  vi.unstubAllEnvs();
  vi.doUnmock("../config/env.ts");
  vi.resetModules();
});

/** One terminal, a fresh simulator and a started agent per test. */
async function fixture(
  options: {
    saleTimeoutMs?: number;
    notFoundGraceMs?: number;
    notFoundTrustWindowMs?: number;
    ignoreAbortDelayMs?: number;
    wrap?: (sim: EcrSimulator) => EdcProvider;
  } = {},
): Promise<Fixture> {
  const sim = new EcrSimulator("bca", {
    ...(options.ignoreAbortDelayMs !== undefined
      ? { ignoreAbortDelayMs: options.ignoreAbortDelayMs }
      : {}),
  });
  const registry = new EdcProviderRegistry().register(
    options.wrap ? options.wrap(sim) : sim,
  );
  const terminalId = await seedTerminal();
  const c = ctx();
  // Not a fresh literal: `notFoundTrustWindowMs` is the agent option A2 adds.
  const agentOptions = {
    db,
    registry,
    saleTimeoutMs: options.saleTimeoutMs ?? 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
    ...(options.notFoundGraceMs !== undefined
      ? { notFoundGraceMs: options.notFoundGraceMs }
      : {}),
    ...(options.notFoundTrustWindowMs !== undefined
      ? { notFoundTrustWindowMs: options.notFoundTrustWindowMs }
      : {}),
  };
  const agent = createEdcAgent(agentOptions);
  started.push({ agent, ctx: c });
  await agent.start(c);
  return { ctx: c, actor: cashier, bca: sim, terminalId, agent };
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

/** The terminal answers the cancel `cancelled`, yet the customer paid: the
 * sale call settles `approved` (and charges at the simulator) only after
 * `open()`. This is the "approved late" case. */
function lateApproval() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { saleStarted: false };
  return {
    open,
    state,
    wrap: (sim: EcrSimulator) =>
      passThrough(sim, {
        cancel: async (r) =>
          ecrResultSchema.parse({
            outcome: "cancelled",
            trace: r.trace,
            amountIdr: null,
          }),
        sale: async (r: EcrSaleRequest) => {
          state.saleStarted = true;
          await gate;
          return sim.sale(r);
        },
      }),
  };
}

/** Starts a sale that the terminal keeps waiting on, cancels it (terminal
 * answers `cancelled`) and returns while the sale call is still in flight. */
async function cancelledButStillSelling(
  f: Fixture,
  state: { saleStarted: boolean },
) {
  const req = request(f);
  const selling = pay(f, req);
  let rowId = "";
  await vi.waitFor(async () => {
    const rows = await rowsFor(req.reference);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.dispatched_at).not.toBeNull();
    expect(state.saleStarted).toBe(true);
    rowId = rows[0]!.id;
  });
  const cancelled = await f.agent.cancel(f.ctx, f.actor, refTo(rowId));
  expect(cancelled.status).toBe("cancelled");
  return { req, selling, rowId };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`edc-rv-${randomUUID().slice(0, 6)}`);
  cashier = await staffUser("EDC Review Kasir");
});

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("EDC review K regressions", () => {
  it("A1 a sale approved after its cancel blocks a re-bill of the same reference with a new key (EDC_NEEDS_RECONCILIATION)", async () => {
    const late = lateApproval();
    const f = await fixture({ saleTimeoutMs: 10_000, wrap: late.wrap });
    const { req, selling } = await cancelledButStillSelling(f, late.state);

    late.open(); // the customer paid anyway: approved after cancelled
    const sold = await selling;
    expect(sold.status).toBe("cancelled");
    expect(sold.needsReconciliation).toBe(true);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);

    // Cashier re-bills the same reference: new idempotency key.
    await expect(
      pay(f, request(f, { reference: req.reference })),
    ).rejects.toMatchObject({ reason: "EDC_NEEDS_RECONCILIATION" });

    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(req.reference);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.needs_reconciliation).toBe(true);
  });

  it("A1 any cancelled, failed or declined row flagged needs_reconciliation blocks a re-bill of the reference", async () => {
    const f = await fixture();
    for (const status of ["cancelled", "failed", "declined"] as const) {
      const reference = refOf();
      await insertRow(f.terminalId, {
        reference,
        status,
        needsReconciliation: true,
      });
      await expect(pay(f, request(f, { reference }))).rejects.toMatchObject({
        reason: "EDC_NEEDS_RECONCILIATION",
      });
      expect(await rowsFor(reference)).toHaveLength(1);
    }
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(f.bca.chargedCount(f.terminalId)).toBe(0);
  });

  it("A1 an unflagged cancelled row does not block a re-bill (control)", async () => {
    const f = await fixture();
    const reference = refOf();
    await insertRow(f.terminalId, { reference, status: "cancelled" });
    const retry = await pay(f, request(f, { reference }));
    expect(retry.status).toBe("approved");
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("A1b a reference whose sale call is still in flight is EDC_STATUS_UNKNOWN even when its row already reads cancelled", async () => {
    const late = lateApproval();
    const f = await fixture({ saleTimeoutMs: 10_000, wrap: late.wrap });
    const other = await seedTerminal(); // same outlet, so the terminal queue is not involved
    const { req, selling } = await cancelledButStillSelling(f, late.state);

    await expect(
      pay(f, request(f, { reference: req.reference, terminalId: other })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(other).sale).toBe(0);
    expect(await rowsFor(req.reference)).toHaveLength(1);

    late.open();
    await selling;
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    expect(f.bca.chargedCount(other)).toBe(0);
    expect(f.bca.callsFor(other).sale).toBe(0);
  });

  it("A2 by_trace not_found for a sale older than the trust window stays unknown and flagged, and the re-bill is refused", async () => {
    // The batch was settled: the terminal no longer sees the trace, but it did charge.
    const f = await fixture({
      notFoundGraceMs: 0,
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async (r) =>
            ecrInquiryResultSchema.parse({
              outcome: "not_found",
              trace: r.trace,
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    await ageDispatch(tx.id, "1 hour"); // default window is 15 minutes

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect(resolved.needsReconciliation).toBe(true);
    const rows = await rowsFor(first.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0]!.needs_reconciliation).toBe(true);

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_NEEDS_RECONCILIATION" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("A2 a smaller notFoundTrustWindowMs option is honored", async () => {
    const f = await fixture({
      notFoundGraceMs: 0,
      notFoundTrustWindowMs: 60_000,
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async (r) =>
            ecrInquiryResultSchema.parse({
              outcome: "not_found",
              trace: r.trace,
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const tx = await pay(f, request(f));
    await ageDispatch(tx.id, "5 minutes");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect(resolved.needsReconciliation).toBe(true);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("A2 not_found inside the trust window is still trusted: failed, and the retry is charged once (control)", async () => {
    const f = await fixture({
      notFoundGraceMs: 0,
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async (r) =>
            ecrInquiryResultSchema.parse({
              outcome: "not_found",
              trace: r.trace,
              batchNo: "000001",
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_before_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    await ageDispatch(tx.id, "1 minute");
    // Same batch at dispatch and at inquiry: no settlement in between.
    await asOwner((client) =>
      client.query(
        `UPDATE edc_transactions SET dispatch_batch_no = '000001' WHERE id = $1`,
        [tx.id],
      ),
    );

    const retry = await pay(f, request(f, { reference: first.reference }));
    expect(retry.status).toBe("approved");
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(first.reference);
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "failed"]);
  });

  it("A3 cancel of an unresolved row waits in the terminal queue while another exchange holds the terminal", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const unresolved = await pay(f, request(f)); // charged, answer lost
    expect(unresolved.status).toBe("unknown");

    f.bca.next(f.terminalId, "hold");
    const heldReq = request(f);
    const heldSelling = pay(f, heldReq);
    let heldTrace = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(heldReq.reference);
      expect(rows).toHaveLength(1);
      expect(f.bca.callsFor(f.terminalId).sale).toBe(2);
      heldTrace = rows[0]!.trace;
    });

    let settled = false;
    const cancelling = f.agent
      .cancel(f.ctx, f.actor, refTo(unresolved.id))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        settled = true;
      });
    await sleep(300);
    // The terminal is busy with the held sale: no cancel may reach it, and
    // the cancel request must still be waiting its turn.
    expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
    expect(settled).toBe(false);

    f.bca.complete(f.terminalId, heldTrace, "approve");
    expect((await heldSelling).status).toBe("approved");
    await cancelling;

    // Never claims a cancel it did not do: the first sale was charged.
    const rows = await rowsFor(unresolved.reference);
    expect(rows[0]!.status).not.toBe("cancelled");
    expect(f.bca.chargedCount(f.terminalId)).toBe(2); // unresolved + held, each once
  });

  it("A3 a sale that settled but is not recorded yet cannot be cancelled around the queue while the next sale holds the terminal", async () => {
    // X's adapter call settles (terminal lock freed, sale Y starts) while X is
    // still in flight: its ledger write is blocked by a row lock taken here.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let saleCalls = 0;
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrap: (sim) =>
        passThrough(sim, {
          sale: async (r: EcrSaleRequest) => {
            saleCalls += 1;
            if (saleCalls > 1) return sim.sale(r);
            await gate;
            const answer = await sim.sale(r);
            sim.next(r.terminal.id, "hold"); // sale Y waits at the terminal
            return answer;
          },
        }),
    });
    const reqX = request(f);
    const sellingX = pay(f, reqX);
    let idX = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(reqX.reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(saleCalls).toBe(1);
      idX = rows[0]!.id;
    });

    const lock = await owner.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        "SELECT id FROM edc_transactions WHERE id = $1 FOR UPDATE",
        [idX],
      );
      const reqY = request(f);
      const sellingY = pay(f, reqY);
      await vi.waitFor(async () => {
        expect(await rowsFor(reqY.reference)).toHaveLength(1);
      });
      open();
      await vi.waitFor(() => {
        expect(f.bca.callsFor(f.terminalId).sale).toBe(2);
      });

      let cancelSettled = false;
      const cancelling = f.agent
        .cancel(f.ctx, f.actor, refTo(idX))
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          cancelSettled = true;
        });
      await sleep(300);
      // Sale Y holds the terminal: no cancel may reach it.
      expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
      expect(cancelSettled).toBe(false);

      await lock.query("COMMIT");
      const rowsY = await rowsFor(reqY.reference);
      f.bca.complete(f.terminalId, rowsY[0]!.trace, "approve");
      expect((await sellingY).status).toBe("approved");
      expect((await sellingX).status).toBe("approved");
      await cancelling;
    } finally {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
    expect(f.bca.chargedCount(f.terminalId)).toBe(2);
  });

  it("A3 two cancels of the sale holding the terminal put one cancel frame on the wire", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let cancelFrames = 0;
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrap: (sim) =>
        passThrough(sim, {
          cancel: async (r) => {
            cancelFrames += 1;
            await gate;
            return sim.cancel(r);
          },
        }),
    });
    f.bca.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let id = "";
    let trace = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(req.reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      id = rows[0]!.id;
      trace = rows[0]!.trace;
    });

    const both = Promise.all([
      f.agent.cancel(f.ctx, f.actor, refTo(id)),
      f.agent.cancel(f.ctx, f.actor, refTo(id)),
    ]);
    await both; // each gives up waiting after cancelTimeoutMs (50 ms)
    expect(cancelFrames).toBe(1);

    open();
    f.bca.complete(f.terminalId, trace, "approve");
    await selling;
  });

  it("A3 the next sale does not start while a bypass cancel of the previous sale is still on the wire", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrap: (sim) =>
        passThrough(sim, {
          // Ignores the abort: still on the wire after the agent gave up.
          cancel: async (r) => {
            await gate;
            return sim.cancel(r);
          },
        }),
    });
    f.bca.next(f.terminalId, "hold");
    const reqX = request(f);
    const sellingX = pay(f, reqX);
    let idX = "";
    let traceX = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(reqX.reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      idX = rows[0]!.id;
      traceX = rows[0]!.trace;
    });
    const reqY = request(f);
    const sellingY = pay(f, reqY);
    await vi.waitFor(async () => {
      expect(await rowsFor(reqY.reference)).toHaveLength(1);
    });

    await f.agent.cancel(f.ctx, f.actor, refTo(idX)); // gives up after 50 ms
    f.bca.complete(f.terminalId, traceX, "approve"); // sale X settles
    await sleep(300);
    // The cancel frame is still on the wire: sale Y must not be dispatched.
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);

    open();
    expect((await sellingY).status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).sale).toBe(2);
    await sellingX;
  });

  it("A3 a sale answer for another trace keeps the evidence and flags the row for reconciliation", async () => {
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          sale: async () =>
            ecrResultSchema.parse({
              outcome: "approved",
              approvalCode: "OTHER01",
              amountIdr: AMOUNT,
              trace: "SOMEOTHERTRACE1",
            }),
        }),
    });
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");
    expect(tx.approvalCode).toBe("OTHER01");
    const rows = await rowsFor(req.reference);
    expect(rows.map((r) => [r.status, r.needs_reconciliation])).toEqual([
      ["unknown", true],
    ]);
    await expect(
      pay(f, request(f, { reference: req.reference })),
    ).rejects.toMatchObject({ reason: "EDC_NEEDS_RECONCILIATION" });
  });

  it("A3 cancel is rejected while the terminal is stuck on a call that ignored the abort", async () => {
    const f = await fixture({ ignoreAbortDelayMs: 3_000 });
    f.bca.next(f.terminalId, "ignore_abort");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");

    await expect(
      f.agent.cancel(f.ctx, f.actor, refTo(tx.id)),
    ).rejects.toMatchObject({ reason: "EDC_TERMINAL_UNAVAILABLE" });
    expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
    const rows = await rowsFor(req.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
  });

  it("A3 an inquiry answer without a trace does not settle the row", async () => {
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async () =>
            ecrInquiryResultSchema.parse({
              outcome: "approved",
              approvalCode: "OTHER01",
              amountIdr: AMOUNT,
              trace: null,
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect(resolved.approvalCode).toBeNull();
    const rows = await rowsFor(req.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("A3 an inquiry answer for another trace does not settle the row", async () => {
    const f = await fixture({
      wrap: (sim) =>
        passThrough(sim, {
          inquiry: async () =>
            ecrInquiryResultSchema.parse({
              outcome: "declined",
              amountIdr: AMOUNT,
              trace: "SOMEOTHERTRACE1",
            }),
        }),
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    const rows = await rowsFor(req.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("A6 a second start() does not flip a live dispatched row to unknown", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    f.bca.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let trace = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(req.reference);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      trace = rows[0]!.trace;
    });

    await f.agent.start(f.ctx).catch(() => undefined); // see assumptions
    const during = await rowsFor(req.reference);
    expect(during.map((r) => r.status)).toEqual(["pending"]);

    f.bca.complete(f.terminalId, trace, "approve");
    const sold = await selling;
    expect(sold.status).toBe("approved");
    const after = await rowsFor(req.reference);
    expect(after.map((r) => r.status)).toEqual(["approved"]);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  describe("B5 registry in production", () => {
    async function registryWith(production: boolean) {
      vi.resetModules();
      vi.stubEnv("NODE_ENV", production ? "production" : "test");
      vi.doMock("../config/env.ts", async (importOriginal) => {
        const original =
          await importOriginal<typeof import("../config/env.ts")>();
        return {
          ...original,
          env: {
            ...original.env,
            NODE_ENV: production ? "production" : "test",
            isProduction: production,
            isTest: !production,
          },
        };
      });
      return import("../edge/edc/registry.ts");
    }

    it("B5 simulator: true throws in production", async () => {
      const { createDefaultEdcRegistry } = await registryWith(true);
      expect(() => createDefaultEdcRegistry({ simulator: true })).toThrow();
    });

    it("B5 simulator: false in production gives an empty registry", async () => {
      const { createDefaultEdcRegistry } = await registryWith(true);
      expect(createDefaultEdcRegistry({ simulator: false }).banks()).toEqual(
        [],
      );
    });

    it("B5 simulator: true still works outside production (control)", async () => {
      const { createDefaultEdcRegistry } = await registryWith(false);
      expect(
        createDefaultEdcRegistry({ simulator: true }).banks().sort(),
      ).toEqual(["bca", "bjb", "bni", "mandiri"]);
    });
  });
});
