// EDC agent service against a real disposable PostgreSQL (bead legend-apt;
// PRD v1.7 §3 F5 "EDC Agent", criteria EDC-02 / EDC-03, EDC-01 amount rule,
// TEN-01 isolation) with the in-memory ECR simulator as the bank adapter.
//
// Assumptions (spec silent, recorded here and in the report):
// - A retry that is refused (EDC_ALREADY_APPROVED / EDC_STATUS_UNKNOWN) writes
//   no new ledger row and sends no new sale.
// - amount_mismatch is recorded as `unknown` (never approved), per the brief.
// - Cancelling an already cancelled transaction returns it (idempotent).
// - Agent API (legend-apt fix batch 1): `start(ctx)` takes the per-outlet
//   advisory lock and recovers; `stop(ctx)` releases it. Every fixture starts
//   its agent and an afterEach stops all of them, so a later test never meets
//   a lock held by an earlier one. Ops on an unstarted agent or a second
//   agent for the same outlet throw EDC_AGENT_NOT_READY.
// - A queued sale's `pending` row is written before it waits for the terminal
//   (so it can be seen and cancelled); a cancelled queued sale is never sent.
// - `last_only` / `none` inquiry and `cancelInProgress:false` are set through
//   the simulator's `capabilities` constructor option; `ignoreAbortDelayMs`
//   is the simulator's constructor option too.
// - A second approval is forced by inserting an approved row for the same
//   reference, then resolving an unknown row of that reference by inquiry.
// - Late approval (F2, rule of legend-ftsq0): a wrapper provider lets the held
//   sale resolve `approved` after the cancel answered `cancelled`. A cancel
//   answer alone never finalizes a dispatched sale, so the row stays `pending`
//   until the sale's own answer and ends `approved`, not flagged.
// - Stale pending (F2): a row that is `pending` but not in flight (set up by
//   flipping an unknown row back to pending, dispatched_at old) is inquired
//   by the retry like an unknown one.
// - Fixtures: two isolated tenants (A, B) and a third for recoverInFlight, so
//   counts are exact; users hold a custom role with `pos.payment.accept`.
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
  ecrResultSchema,
  type EcrSaleRequest,
  type EdcBank,
  type EdcProvider,
  type EdcProviderCapabilities,
  type EdcMethod,
  type EdcPaymentRequest,
  type EdcTransaction,
} from "@starter/shared/edc";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { ensureBill } from "./edc-agent-bill-helper.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { agent as httpAgent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const app = createApp();
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let tenantC: IsolatedTenant;
let cashierA: string;
let cashierB: string;
let cashierC: string;
let noPaymentA: string;
const tenantIds: string[] = [];

const ctxFor = (tenant: IsolatedTenant): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

async function asOwner<T>(
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

async function staffUser(
  tenant: IsolatedTenant,
  permissions: string[],
  label: string,
): Promise<string> {
  const client = httpAgent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, tenant.tenantId, label, JSON.stringify(permissions)],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return userId;
}

async function seedTerminal(
  tenant: IsolatedTenant,
  options: {
    bank?: EdcBank;
    status?: "active" | "inactive";
    methods?: EdcMethod[];
  } = {},
): Promise<string> {
  const id = randomUUID();
  await asOwner(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, $4, $5, 'MID-TEST', 'Test EDC', 'lan', '10.0.0.5', $6, $7)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        options.bank ?? "bca",
        `TID-${id.slice(0, 8)}`,
        options.methods ?? ["card", "qris"],
        options.status ?? "active",
      ],
    ),
  );
  return id;
}

type Row = {
  id: string;
  status: string;
  reference: string;
  idempotency_key: string;
  completed_at: Date | null;
  inquiry_count: number;
  trace: string;
  message: string | null;
  needs_reconciliation: boolean;
  dispatched_at: Date | null;
};

async function rowsFor(
  tenant: IsolatedTenant,
  where: { reference?: string; terminalId?: string },
): Promise<Row[]> {
  return asOwner(tenant.tenantId, async (client) => {
    const result = await client.query<Row>(
      `SELECT id, status, reference, idempotency_key, completed_at, inquiry_count, trace,
              message, needs_reconciliation, dispatched_at
       FROM edc_transactions
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR reference = $2)
         AND ($3::uuid IS NULL OR terminal_id = $3)
       ORDER BY created_at, id`,
      [tenant.tenantId, where.reference ?? null, where.terminalId ?? null],
    );
    return result.rows;
  });
}

async function insertRow(
  tenant: IsolatedTenant,
  terminalId: string,
  row: {
    reference: string;
    status: "pending" | "unknown" | "approved";
    trace?: string;
    dispatched: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const trace = row.trace ?? `T${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await asOwner(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace, completed_at, dispatched_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-test', $9, 'card', $7::varchar, $8,
               CASE WHEN $7::varchar IN ('pending', 'unknown') THEN NULL ELSE now() END,
               CASE WHEN $10::boolean THEN now() ELSE NULL END)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalId,
        row.reference,
        randomUUID(),
        row.status,
        trace,
        AMOUNT,
        row.dispatched,
      ],
    ),
  );
  return id;
}

type Fixture = {
  tenant: IsolatedTenant;
  ctx: ScopedTenantContext;
  actor: string;
  bca: EcrSimulator;
  registry: EdcProviderRegistry;
  terminalId: string;
  agent: ReturnType<typeof createEdcAgent>;
};

// Every agent a test starts is stopped afterwards (advisory lock + client).
const startedAgents: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];

afterEach(async () => {
  const all = startedAgents.splice(0);
  for (const { agent, ctx } of all) {
    await agent.stop(ctx).catch(() => undefined);
  }
});

async function startAgent(
  agent: ReturnType<typeof createEdcAgent>,
  ctx: ScopedTenantContext,
): Promise<void> {
  startedAgents.push({ agent, ctx });
  await agent.start(ctx);
}

/** One terminal, one fresh simulator and agent per test: state never leaks. */
async function fixture(
  options: {
    tenant?: IsolatedTenant;
    actor?: string;
    saleTimeoutMs?: number;
    notFoundGraceMs?: number;
    capabilities?: EdcProviderCapabilities;
    ignoreAbortDelayMs?: number;
    start?: boolean;
    terminal?: Parameters<typeof seedTerminal>[1];
    banks?: EdcBank[];
    /** Wraps the bca simulator in a custom provider (registered instead). */
    wrapBca?: (sim: EcrSimulator) => EdcProvider;
  } = {},
): Promise<Fixture> {
  const tenant = options.tenant ?? tenantA;
  const registry = new EdcProviderRegistry();
  const sims = new Map<EdcBank, EcrSimulator>();
  for (const bank of options.banks ?? ["bca", "mandiri", "bni", "bjb"]) {
    const sim = new EcrSimulator(bank, {
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.ignoreAbortDelayMs !== undefined
        ? { ignoreAbortDelayMs: options.ignoreAbortDelayMs }
        : {}),
    });
    sims.set(bank, sim);
    registry.register(
      bank === "bca" && options.wrapBca ? options.wrapBca(sim) : sim,
    );
  }
  const terminalId = await seedTerminal(tenant, options.terminal);
  const ctx = ctxFor(tenant);
  const agent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: options.saleTimeoutMs ?? 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
    ...(options.notFoundGraceMs !== undefined
      ? { notFoundGraceMs: options.notFoundGraceMs }
      : {}),
  });
  if (options.start !== false) await startAgent(agent, ctx);
  return {
    tenant,
    ctx,
    actor: options.actor ?? cashierA,
    bca: sims.get("bca") ?? new EcrSimulator("bca"),
    registry,
    terminalId,
    agent,
  };
}

const AMOUNT = 55_000;
const refOf = () => `BILL-${randomUUID().slice(0, 8)}`;

function request(
  f: Fixture,
  over: Partial<EdcPaymentRequest> = {},
): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(f.tenant.tenantId),
    outletId: outletIdSchema.parse(f.tenant.outletId),
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

const refTo = (f: Fixture, tx: Pick<EdcTransaction, "id">) => ({
  tenantId: tenantIdSchema.parse(f.tenant.tenantId),
  outletId: outletIdSchema.parse(f.tenant.outletId),
  transactionId: tx.id,
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantA = await createIsolatedTenant(`edc-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`edc-b-${randomUUID().slice(0, 6)}`);
  tenantC = await createIsolatedTenant(`edc-c-${randomUUID().slice(0, 6)}`);
  tenantIds.push(tenantA.tenantId, tenantB.tenantId, tenantC.tenantId);
  cashierA = await staffUser(tenantA, ["pos.payment.accept"], "EDC Kasir A");
  cashierB = await staffUser(tenantB, ["pos.payment.accept"], "EDC Kasir B");
  cashierC = await staffUser(tenantC, ["pos.payment.accept"], "EDC Kasir C");
  noPaymentA = await staffUser(
    tenantA,
    ["floor.table.view"],
    "EDC Tanpa Bayar",
  );
});

afterAll(async () => {
  // Ledger rows and audit rows are retained; give the isolated tenants a valid
  // creator so the platform tenant list still parses them.
  await owner.query(
    "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
    [tenantIds, randomUUID()],
  );
  await owner.end();
});

describe("EDC agent (legend-apt)", () => {
  it("EDC-02 an approved card sale returns approval code, masked PAN and the billed amount", async () => {
    const f = await fixture();
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("approved");
    expect(tx.approvalCode).toBeTruthy();
    expect(tx.maskedPan).toBe("411111******1111");
    expect(tx.cardType).toBe("VISA");
    expect(tx.responseCode).toBe("00");
    expect(tx.amountIdr).toBe(AMOUNT);
    expect(tx.reference).toBe(req.reference);
    expect(tx.completedAt).not.toBeNull();
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.map((r) => r.status)).toEqual(["approved"]);
    expect(rows[0]!.completed_at).not.toBeNull();
  });

  it("EDC-02 an approved QRIS sale carries no card number", async () => {
    const f = await fixture();
    const tx = await pay(f, request(f, { method: "qris" }));
    expect(tx.status).toBe("approved");
    expect(tx.method).toBe("qris");
    expect(tx.maskedPan).toBeNull();
  });

  it("EDC-02 a declined card is declined, never approved", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "decline");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("declined");
    expect(tx.responseCode).toBe("51");
    expect(tx.approvalCode).toBeNull();
    expect(tx.completedAt).not.toBeNull();
    expect(f.bca.chargedCount(f.terminalId)).toBe(0);
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.map((r) => r.status)).toEqual(["declined"]);
  });

  it("EDC-03 a lost answer after the charge is unknown, and a retry inquires first and refuses to charge twice", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(tx.completedAt).toBeNull();
    expect(tx.amountIdr).toBe(AMOUNT);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);

    // Cashier presses "pay" again: same bill, new idempotency key.
    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_ALREADY_APPROVED" });

    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.callsFor(f.terminalId).inquiry).toBeGreaterThanOrEqual(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    // The unknown attempt was resolved to what really happened.
    const rows = await rowsFor(f.tenant, { reference: first.reference });
    expect(rows.map((r) => r.status)).toEqual(["approved"]);
    const settled = await f.agent.get(f.ctx, f.actor, refTo(f, tx));
    expect(settled.id).toBe(tx.id);
    expect(settled.amountIdr).toBe(AMOUNT);
    expect(settled.reference).toBe(first.reference);
  });

  it("EDC-03 a sale that never reached the terminal is failed by inquiry and the retry is charged once", async () => {
    // Grace 0: the sale is old enough that "not found" is trusted.
    const f = await fixture({ notFoundGraceMs: 0 });
    f.bca.next(f.terminalId, "timeout_before_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(f.bca.chargedCount(f.terminalId)).toBe(0);
    // The failure is instant, so age the dispatch past saleTimeoutMs + grace:
    // no dependence on wall-clock timing. The terminal's batch at dispatch is
    // the one its not_found reports ("000001"): no settlement in between.
    await asOwner(f.tenant.tenantId, (client) =>
      client.query(
        `UPDATE edc_transactions SET dispatched_at = now() - interval '1 minute', dispatch_batch_no = '000001' WHERE id = $1`,
        [tx.id],
      ),
    );

    const retry = await pay(f, request(f, { reference: first.reference }));
    expect(retry.status).toBe("approved");
    expect(retry.id).not.toBe(tx.id);
    expect(f.bca.callsFor(f.terminalId).sale).toBe(2);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: first.reference });
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "failed"]);
  });

  it("EDC-03 when the inquiry itself times out the status stays unknown and the retry is refused without a new sale", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    f.bca.next(f.terminalId, "inquiry_timeout");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: first.reference });
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);

    // Once the terminal answers again the inquiry resolves it.
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("EDC-03 a customer still paying at the terminal stays unknown and blocks a second sale until it finishes", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "hold");
    const first = request(f);
    const tx = await pay(f, first); // sale timeout (50 ms) while the customer waits
    expect(tx.status).toBe("unknown");

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);

    f.bca.complete(f.terminalId, tx.trace, "approve");
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.status).toBe("approved");
    expect(resolved.approvalCode).toBeTruthy();
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("EDC-03 a disconnect is unknown and an explicit inquiry resolves it to approved", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "disconnect");
    const tx = await pay(f, request(f));
    expect(tx.status).toBe("unknown");
    expect(tx.completedAt).toBeNull();

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.status).toBe("approved");
    expect(resolved.id).toBe(tx.id);
    expect(resolved.inquiryCount).toBe(1);
    expect(resolved.completedAt).not.toBeNull();
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);

    // A final transaction is returned as is, without asking the terminal.
    const inquiriesBefore = f.bca.callsFor(f.terminalId).inquiry;
    const again = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(again.status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).inquiry).toBe(inquiriesBefore);
  });

  it("EDC-01 an amount different from the bill is never recorded as approved", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "amount_mismatch");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).not.toBe("approved");
    // Assumption: the brief records a mismatch as `unknown` for reconciliation.
    expect(tx.status).toBe("unknown");
    expect(tx.amountIdr).toBe(AMOUNT);
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.every((r) => r.status !== "approved")).toBe(true);
  });

  it("EDC-03 the same idempotency key returns the same transaction and sends one sale", async () => {
    const f = await fixture();
    const req = request(f);
    const first = await pay(f, req);
    const replay = await pay(f, req);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { terminalId: f.terminalId });
    expect(rows).toHaveLength(1);
  });

  it("EDC-03 replaying the key of an unknown transaction inquires it instead of selling again", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    const req = request(f);
    const first = await pay(f, req);
    expect(first.status).toBe("unknown");
    const replay = await pay(f, req);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("approved");
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("EDC-03 the same idempotency key with a different amount is rejected", async () => {
    const f = await fixture();
    const req = request(f);
    await pay(f, req);
    await expect(
      pay(f, { ...req, amountIdr: idr(AMOUNT + 1_000) }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
  });

  it("EDC-02 cancelling a sale held at the terminal cancels it, resolves the held sale and stays cancelled", async () => {
    // Long sale timeout: the customer is still deciding when the cashier cancels.
    let releaseSale!: () => void;
    const saleReply = new Promise<void>((resolve) => {
      releaseSale = resolve;
    });
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrapBca: (sim) => ({
        bank: sim.bank,
        capabilities: sim.capabilities,
        cancel: (r) => sim.cancel(r),
        inquiry: (r) => sim.inquiry(r),
        void: (r) => sim.void(r),
        sale: async (r) => {
          const answer = await sim.sale(r);
          // The simulator's cancel also resolves sale. Hold that separate reply
          // so this assertion observes the cancel answer before the sale answer.
          await saleReply;
          return answer;
        },
      }),
    });
    f.bca.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let rowId = "";
    try {
      await vi.waitFor(async () => {
        const rows = await rowsFor(f.tenant, { reference: req.reference });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("pending");
        expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
        rowId = rows[0]!.id;
      });

      const cancelled = await f.agent.cancel(
        f.ctx,
        f.actor,
        refTo(f, { id: rowId }),
      );
      // The cancel answer is no proof the sale is over: the row stays open and
      // the sale's own answer (below) decides.
      expect(cancelled.status).toBe("pending");
      expect(cancelled.completedAt).toBeNull();
    } finally {
      releaseSale();
    }

    const sold = await selling;
    expect(sold.id).toBe(rowId);
    expect(sold.status).toBe("cancelled");
    expect(f.bca.chargedCount(f.terminalId)).toBe(0);
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);

    // Cancelling again is harmless and still reports cancelled.
    const again = await f.agent.cancel(f.ctx, f.actor, refTo(f, { id: rowId }));
    expect(again.status).toBe("cancelled");

    // A cancelled attempt does not block a new attempt for the same bill.
    const retry = await pay(f, request(f, { reference: req.reference }));
    expect(retry.status).toBe("approved");
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
  });

  it("EDC-02 an approved transaction cannot be cancelled", async () => {
    const f = await fixture();
    const tx = await pay(f, request(f));
    expect(tx.status).toBe("approved");
    await expect(
      f.agent.cancel(f.ctx, f.actor, refTo(f, tx)),
    ).rejects.toMatchObject({ reason: "EDC_NOT_CANCELLABLE" });
    const after = await f.agent.get(f.ctx, f.actor, refTo(f, tx));
    expect(after.status).toBe("approved");
  });

  it("EDC-05 a terminal whose bank has no registered provider is refused before any row is written", async () => {
    const f = await fixture({ banks: ["bca"], terminal: { bank: "bni" } });
    await expect(pay(f, request(f))).rejects.toMatchObject({
      reason: "EDC_PROVIDER_UNKNOWN",
    });
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-05 an inactive terminal is unavailable and nothing is sent", async () => {
    const f = await fixture({ terminal: { status: "inactive" } });
    await expect(pay(f, request(f))).rejects.toMatchObject({
      reason: "EDC_TERMINAL_UNAVAILABLE",
    });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-05 a method the terminal does not support is unavailable and nothing is sent", async () => {
    const f = await fixture({ terminal: { methods: ["card"] } });
    await expect(pay(f, request(f, { method: "qris" }))).rejects.toMatchObject({
      reason: "EDC_TERMINAL_UNAVAILABLE",
    });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-03 recoverInFlight turns a pending row left by a crash into unknown", async () => {
    // Own tenant so the returned count is exact.
    const f = await fixture({ tenant: tenantC, actor: cashierC });
    const pendingId = await insertRow(tenantC, f.terminalId, {
      reference: refOf(),
      status: "pending",
      dispatched: true,
    });
    const approvedId = await insertRow(tenantC, f.terminalId, {
      reference: refOf(),
      status: "approved",
      dispatched: true,
    });

    const count = await f.agent.recoverInFlight(f.ctx);
    expect(count).toBe(1);
    const rows = await rowsFor(tenantC, { terminalId: f.terminalId });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pendingId)!.status).toBe("unknown");
    expect(byId.get(pendingId)!.completed_at).toBeNull();
    expect(byId.get(approvedId)!.status).toBe("approved");
    // Nothing left to recover the second time.
    expect(await f.agent.recoverInFlight(f.ctx)).toBe(0);
  });

  it("EDC-03 a second agent for the same outlet cannot start, and ops on it are not ready", async () => {
    const f = await fixture();
    const second = createEdcAgent({
      db,
      registry: f.registry,
      saleTimeoutMs: 50,
      inquiryTimeoutMs: 50,
      cancelTimeoutMs: 50,
    });
    await expect(second.start(f.ctx)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    const req = request(f);
    await expect(
      second.requestPayment(f.ctx, f.actor, req),
    ).rejects.toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    await expect(
      second.get(f.ctx, f.actor, refTo(f, { id: randomUUID() })),
    ).rejects.toMatchObject({ reason: "EDC_AGENT_NOT_READY" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );

    // After the owner stops, the lock is free and the second agent takes over.
    await f.agent.stop(f.ctx);
    await startAgent(second, f.ctx);
    await ensureBill(owner, req);
    const tx = await second.requestPayment(f.ctx, f.actor, req);
    expect(tx.status).toBe("approved");
  });

  it("EDC-03 an agent that was never started refuses every operation and writes nothing", async () => {
    const f = await fixture({ start: false });
    const req = request(f);
    await expect(pay(f, req)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    const ref = refTo(f, { id: randomUUID() });
    await expect(f.agent.inquire(f.ctx, f.actor, ref)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    await expect(f.agent.cancel(f.ctx, f.actor, ref)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    await expect(f.agent.get(f.ctx, f.actor, ref)).rejects.toMatchObject({
      reason: "EDC_AGENT_NOT_READY",
    });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-03 cancelling a queued sale behind a held sale cancels it locally and never sends it", async () => {
    const f = await fixture({ saleTimeoutMs: 10_000 });
    f.bca.next(f.terminalId, "hold");
    const heldReq = request(f);
    const queuedReq = request(f);
    const heldSelling = pay(f, heldReq);
    let heldRow = { id: "", trace: "" };
    await vi.waitFor(async () => {
      const rows = await rowsFor(f.tenant, { reference: heldReq.reference });
      expect(rows).toHaveLength(1);
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      heldRow = { id: rows[0]!.id, trace: rows[0]!.trace };
    });

    // Second sale queues behind the terminal lock; its row is pending.
    const queuedSelling = pay(f, queuedReq);
    let queuedId = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(f.tenant, { reference: queuedReq.reference });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      queuedId = rows[0]!.id;
    });

    const cancelled = await f.agent.cancel(
      f.ctx,
      f.actor,
      refTo(f, { id: queuedId }),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.dispatchedAt).toBeNull();
    expect(cancelled.completedAt).not.toBeNull();
    // No terminal call for the cancel, and the held sale is untouched.
    expect(f.bca.callsFor(f.terminalId).cancel).toBe(0);
    const heldNow = await rowsFor(f.tenant, { reference: heldReq.reference });
    expect(heldNow.map((r) => r.status)).toEqual(["pending"]);

    f.bca.complete(f.terminalId, heldRow.trace, "approve");
    const held = await heldSelling;
    expect(held.id).toBe(heldRow.id);
    expect(held.status).toBe("approved");
    const queued = await queuedSelling;
    expect(queued.id).toBe(queuedId);
    expect(queued.status).toBe("cancelled");

    // The simulator never received the cancelled sale.
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: queuedReq.reference });
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("EDC-03 a recovered row that was never dispatched is failed by inquiry without any terminal call", async () => {
    const f = await fixture({ tenant: tenantC, actor: cashierC });
    const terminal = await seedTerminal(tenantC);
    const id = await insertRow(tenantC, terminal, {
      reference: refOf(),
      status: "pending",
      dispatched: false,
    });
    await f.agent.recoverInFlight(f.ctx);
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, { id }));
    expect(resolved.status).toBe("failed");
    expect(resolved.completedAt).not.toBeNull();
    expect(f.bca.callsFor(terminal)).toEqual({
      sale: 0,
      cancel: 0,
      inquiry: 0,
      void: 0,
    });
  });

  it("EDC-03 a recovered row that was dispatched stays unknown (the charge may exist)", async () => {
    const f = await fixture({ tenant: tenantC, actor: cashierC });
    const terminal = await seedTerminal(tenantC);
    const id = await insertRow(tenantC, terminal, {
      reference: refOf(),
      status: "pending",
      dispatched: true,
    });
    await f.agent.recoverInFlight(f.ctx);
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, { id }));
    expect(resolved.status).toBe("unknown");
    expect(resolved.completedAt).toBeNull();
    expect(f.bca.callsFor(terminal).sale).toBe(0);
  });

  it("EDC-03 not_found right after dispatch is not trusted within the grace: stays unknown and the retry is refused", async () => {
    const f = await fixture(); // default grace (30 s)
    f.bca.next(f.terminalId, "timeout_before_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: first.reference });
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
  });

  it("EDC-03 a last_only terminal's not_found never turns an unknown sale into failed", async () => {
    const f = await fixture({
      notFoundGraceMs: 0,
      capabilities: { inquiry: "last_only", cancelInProgress: true },
    });
    f.bca.next(f.terminalId, "timeout_before_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.status).toBe("unknown");
    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
  });

  it("EDC-03 a terminal without inquiry is never inquired: unknown stays unknown and the retry is refused", async () => {
    const f = await fixture({
      notFoundGraceMs: 0,
      capabilities: { inquiry: "none", cancelInProgress: true },
    });
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");

    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.status).toBe("unknown");
    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_STATUS_UNKNOWN" });
    expect(f.bca.callsFor(f.terminalId).inquiry).toBe(0);
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
  });

  it("EDC-01 an approval without an amount is never recorded as approved", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "no_amount");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.every((r) => r.status !== "approved")).toBe(true);
  });

  it("EDC-01 an approval that echoes another trace is never recorded as approved", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "wrong_trace");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown");
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.every((r) => r.status !== "approved")).toBe(true);
  });

  it("EDC-02 a card number in the terminal message is masked before it is stored", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "pan_in_message");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("approved");
    const digitRun = /\d(?:[\s/_-]*\d){11,}/;
    expect(tx.message ?? "").not.toMatch(digitRun);
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows[0]!.message).not.toBeNull();
    expect(rows[0]!.message!).not.toMatch(digitRun);
  });

  it("EDC-03 a terminal that ignores the abort stays unavailable until it settles, then works again", async () => {
    const f = await fixture({ saleTimeoutMs: 50, ignoreAbortDelayMs: 1_000 });
    f.bca.next(f.terminalId, "ignore_abort");
    const first = await pay(f, request(f));
    expect(first.status).toBe("unknown");

    // Immediately after: the terminal is still busy with the stuck call.
    const blocked = request(f);
    await expect(pay(f, blocked)).rejects.toMatchObject({
      reason: "EDC_TERMINAL_UNAVAILABLE",
    });
    expect(
      await rowsFor(f.tenant, { reference: blocked.reference }),
    ).toHaveLength(0);
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);

    // Once the adapter settles the terminal frees; a refused attempt wrote no
    // row, so the same request can be repeated until it is accepted.
    let ok: EdcTransaction | undefined;
    await vi.waitFor(
      async () => {
        ok = await pay(f, blocked);
      },
      { timeout: 8_000, interval: 50 },
    );
    expect(ok?.status).toBe("approved");
  });

  it("EDC-03 cancelling a held sale on a terminal that cannot cancel in progress is unsupported", async () => {
    const f = await fixture({
      saleTimeoutMs: 10_000,
      capabilities: { inquiry: "by_trace", cancelInProgress: false },
    });
    f.bca.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let row = { id: "", trace: "" };
    await vi.waitFor(async () => {
      const rows = await rowsFor(f.tenant, { reference: req.reference });
      expect(rows).toHaveLength(1);
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      row = { id: rows[0]!.id, trace: rows[0]!.trace };
    });

    await expect(
      f.agent.cancel(f.ctx, f.actor, refTo(f, { id: row.id })),
    ).rejects.toMatchObject({ reason: "EDC_CANCEL_UNSUPPORTED" });
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows.map((r) => r.status)).toEqual(["pending"]);

    // The cashier cancels at the terminal; the sale resolves as the terminal says.
    f.bca.complete(f.terminalId, row.trace, "approve");
    const sold = await selling;
    expect(sold.status).toBe("approved");
  });

  it("EDC-03 a second approval for the same reference is unknown and flagged for reconciliation", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    const req = request(f);
    const tx = await pay(f, req);
    expect(tx.status).toBe("unknown"); // terminal charged, answer lost
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);

    // Another approved row for the same bill appeared meanwhile.
    await insertRow(f.tenant, f.terminalId, {
      reference: req.reference,
      status: "approved",
      dispatched: true,
    });

    // The inquiry says the unknown sale was approved too: charged twice.
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(f, tx));
    expect(resolved.id).toBe(tx.id);
    expect(resolved.status).toBe("unknown");
    expect(resolved.needsReconciliation).toBe(true);
    expect(resolved.message ?? "").toContain("approved twice");
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    const unknownRow = rows.find((r) => r.id === tx.id)!;
    expect(unknownRow.status).toBe("unknown");
    expect(unknownRow.needs_reconciliation).toBe(true);
    expect(rows.filter((r) => r.status === "approved")).toHaveLength(1);
  });

  it("EDC-03 a held sale that is approved after the cancel answer is approved: the cancel answer alone never finalizes it", async () => {
    // Wrapper: the terminal answers the cancel (cancelled), but the sale
    // call itself later settles approved (the customer paid anyway).
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const f = await fixture({
      saleTimeoutMs: 10_000,
      wrapBca: (sim) => ({
        bank: sim.bank,
        capabilities: sim.capabilities,
        cancel: (r) => sim.cancel(r),
        inquiry: (r) => sim.inquiry(r),
        void: (r) => sim.void(r),
        sale: async (r: EcrSaleRequest) => {
          await sim.sale(r); // held until the cancel resolves it
          await gate;
          return ecrResultSchema.parse({
            outcome: "approved",
            approvalCode: "APLATE1",
            amountIdr: r.amountIdr,
            trace: r.trace,
          });
        },
      }),
    });
    f.bca.next(f.terminalId, "hold");
    const req = request(f);
    const selling = pay(f, req);
    let rowId = "";
    await vi.waitFor(async () => {
      const rows = await rowsFor(f.tenant, { reference: req.reference });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
      rowId = rows[0]!.id;
    });

    const cancelled = await f.agent.cancel(
      f.ctx,
      f.actor,
      refTo(f, { id: rowId }),
    );
    expect(cancelled.status).toBe("pending");

    open(); // the sale now answers approved: the customer paid
    const sold = await selling;
    expect(sold.status).toBe("approved");
    const rows = await rowsFor(f.tenant, { reference: req.reference });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("approved");
    expect(rows[0]!.needs_reconciliation).toBe(false);
  });

  it("EDC-03 a stale pending row that is not in flight is inquired by the retry: approved at the terminal refuses a second charge", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    // Make it a stale pending row: dispatched long ago, nobody is awaiting it.
    await asOwner(f.tenant.tenantId, (client) =>
      client.query(
        `UPDATE edc_transactions
         SET status = 'pending', dispatched_at = now() - interval '1 minute'
         WHERE id = $1`,
        [tx.id],
      ),
    );
    const inquiriesBefore = f.bca.callsFor(f.terminalId).inquiry;

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_ALREADY_APPROVED" });
    expect(f.bca.callsFor(f.terminalId).inquiry).toBeGreaterThan(
      inquiriesBefore,
    );
    expect(f.bca.callsFor(f.terminalId).sale).toBe(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { reference: first.reference });
    expect(rows.map((r) => r.status)).toEqual(["approved"]);
  });

  it("EDC-03 a stale pending row the terminal never saw is failed by the retry's inquiry and a new sale is allowed", async () => {
    const f = await fixture({ notFoundGraceMs: 0 });
    const reference = refOf();
    const staleId = await insertRow(f.tenant, f.terminalId, {
      reference,
      status: "pending",
      dispatched: true,
    });
    await asOwner(f.tenant.tenantId, (client) =>
      client.query(
        `UPDATE edc_transactions SET dispatched_at = now() - interval '1 minute', dispatch_batch_no = '000001' WHERE id = $1`,
        [staleId],
      ),
    );

    const retry = await pay(f, request(f, { reference }));
    expect(retry.status).toBe("approved");
    expect(retry.id).not.toBe(staleId);
    expect(f.bca.callsFor(f.terminalId).inquiry).toBeGreaterThanOrEqual(1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(1);
    const rows = await rowsFor(f.tenant, { reference });
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "failed"]);
  });

  it("EDC-03 the same reference in another outlet of the same tenant is allowed", async () => {
    const outletB = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet B', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
      [
        outletB,
        tenantA.tenantId,
        tenantA.brandId,
        tenantA.legalEntityId,
        `OB-${outletB.slice(0, 8)}`.toUpperCase(),
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    const a = await fixture();
    const b = await fixture({ tenant: { ...tenantA, outletId: outletB } });
    const reference = refOf();
    const txA = await pay(a, request(a, { reference }));
    const txB = await pay(b, request(b, { reference }));
    expect(txA.status).toBe("approved");
    expect(txB.status).toBe("approved");
    expect(txB.id).not.toBe(txA.id);
    expect(txB.needsReconciliation).toBe(false);
    const rows = await rowsFor(tenantA, { reference });
    expect(rows.map((r) => r.status)).toEqual(["approved", "approved"]);
  });

  it("TEN-01 another tenant cannot read, inquire or cancel a transaction", async () => {
    const a = await fixture();
    const tx = await pay(a, request(a));
    expect(tx.status).toBe("approved");

    const b = await fixture({ tenant: tenantB, actor: cashierB });
    const foreign = refTo(b, tx); // B's own tenant/outlet, A's transaction id
    await expect(b.agent.get(b.ctx, b.actor, foreign)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      b.agent.inquire(b.ctx, b.actor, foreign),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.agent.cancel(b.ctx, b.actor, foreign)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    // Naming tenant A in the request does not widen B's context.
    await expect(
      b.agent.get(b.ctx, b.actor, refTo(a, tx)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A's transaction is untouched.
    const still = await a.agent.get(a.ctx, a.actor, refTo(a, tx));
    expect(still.status).toBe("approved");

    // Database level: tenant B's restricted login sees 0 rows, A's sees 1.
    const visible = async (tenant: IsolatedTenant) => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_app");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenant.tenantId],
        );
        const result = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM edc_transactions WHERE id = $1",
          [tx.id],
        );
        return result.rows[0]!.count;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    expect(await visible(tenantB)).toBe("0");
    expect(await visible(tenantA)).toBe("1");
  });

  it("TEN-01 a request naming another tenant is refused and sends nothing", async () => {
    const a = await fixture();
    const b = await fixture({ tenant: tenantB, actor: cashierB });
    await expect(
      pay(a, request(b)), // B's tenant/outlet/terminal under A's context
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(b.bca.callsFor(b.terminalId).sale).toBe(0);
    expect(await rowsFor(tenantB, { terminalId: b.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-02 a user without pos.payment.accept cannot start a payment", async () => {
    const f = await fixture({ actor: noPaymentA });
    await expect(pay(f, request(f))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });

  it("EDC-01 a zero or unknown-field request is rejected before anything happens", async () => {
    const f = await fixture();
    await expect(
      pay(f, request(f, { amountIdr: 0 as never })),
    ).rejects.toThrow();
    await expect(
      pay(f, { ...request(f), cashierTypedAmount: 1 } as never),
    ).rejects.toThrow();
    expect(f.bca.callsFor(f.terminalId).sale).toBe(0);
    expect(await rowsFor(f.tenant, { terminalId: f.terminalId })).toHaveLength(
      0,
    );
  });
});
