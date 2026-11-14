// Round 2 tests (docs/briefs/sub-edc-review-k.md, "Round 2"): a by_trace
// `not_found` is only trusted as "never charged" when the terminal's batch is
// the same as at dispatch. Written to the brief, not to the implementation:
// they are expected to fail until `dispatch_batch_no`, the batchNo on
// not_found inquiries and `EcrSimulator.closeBatch(terminalRowId)` land.
// Real disposable PostgreSQL, in-memory ECR simulator as the bank adapter.
//
// Assumptions (brief silent, also in the report):
// - Batch numbers are the simulator's 6-digit strings, first batch "000001",
//   `closeBatch` moves it to "000002".
// - "Known batch" is established by one approved sale on the same terminal
//   (its row stores `batch_no`), as the brief says for existing tests.
// - "X times out, terminal actually approved" is the simulator mode
//   `timeout_after_charge`; "never charged" is `timeout_before_charge`.
// - The inquiry is driven explicitly with `agent.inquire` (grace 0), as in
//   edc-agent-review.test.ts; the re-bill then must be refused either way.
// - chargedCount is asserted as a delta against the count taken after the
//   known-batch sale, because the same terminal also holds that earlier sale.
// - `batch_no` is the ledger column holding the batch of a settled answer.
import { randomUUID } from "node:crypto";
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
import { createEdcAgent } from "../edge/edc/agent.ts";
import { ensureBill } from "./edc-agent-bill-helper.ts";
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
let tenant: IsolatedTenant;
let cashier: string;

const AMOUNT = 55_000;
const refOf = () => `BAT-${randomUUID().slice(0, 8)}`;

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
  message: string | null;
  needs_reconciliation: boolean;
  batch_no: string | null;
  dispatch_batch_no: string | null;
};

async function rowsFor(reference: string): Promise<Row[]> {
  return asOwner(async (client) => {
    const result = await client.query<Row>(
      `SELECT id, status, reference, message, needs_reconciliation,
              batch_no, dispatch_batch_no
       FROM edc_transactions
       WHERE tenant_id = $1 AND reference = $2
       ORDER BY created_at, id`,
      [tenant.tenantId, reference],
    );
    return result.rows;
  });
}

type Fixture = {
  ctx: ScopedTenantContext;
  actor: string;
  bca: EcrSimulator;
  terminalId: string;
  agent: ReturnType<typeof createEdcAgent>;
  /** Moves the agent's clock forward, so a sale is old enough (past
   * saleTimeoutMs + grace) for its inquiry `not_found` to be weighed. */
  advance: (ms: number) => void;
};

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];

afterEach(async () => {
  for (const { agent, ctx: c } of started.splice(0))
    await agent.stop(c).catch(() => undefined);
});

/** One terminal, a fresh simulator and a started agent per test. */
async function fixture(): Promise<Fixture> {
  const sim = new EcrSimulator("bca");
  const registry = new EdcProviderRegistry().register(sim);
  const terminalId = await seedTerminal();
  const c = ctx();
  let skewMs = 0;
  const agent = createEdcAgent({
    db,
    registry,
    now: () => new Date(Date.now() + skewMs),
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
    notFoundGraceMs: 0,
  });
  started.push({ agent, ctx: c });
  await agent.start(c);
  return {
    ctx: c,
    actor: cashier,
    bca: sim,
    terminalId,
    agent,
    advance: (ms) => {
      skewMs += ms;
    },
  };
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

/** One approved sale: the terminal's batch ("000001") becomes known to the ledger. */
async function settleOneApprovedSale(f: Fixture): Promise<Row> {
  const reference = refOf();
  const tx = await pay(f, request(f, { reference }));
  expect(tx.status).toBe("approved");
  const [row] = await rowsFor(reference);
  expect(row!.batch_no).toBe("000001");
  return row!;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`edc-bt-${randomUUID().slice(0, 6)}`);
  cashier = await staffUser("EDC Batch Kasir");
});

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("EDC batch check before trusting not_found", () => {
  it("B1 a batch closed after a charged sale makes not_found untrusted: unknown, flagged, and the re-bill is refused without a second charge", async () => {
    const f = await fixture();
    await settleOneApprovedSale(f);
    const chargedBefore = f.bca.chargedCount(f.terminalId);
    const salesBefore = f.bca.callsFor(f.terminalId).sale;

    f.bca.next(f.terminalId, "timeout_after_charge"); // terminal approved, answer lost
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(f.bca.chargedCount(f.terminalId)).toBe(chargedBefore + 1);
    expect((await rowsFor(first.reference))[0]!.dispatch_batch_no).toBe(
      "000001",
    );

    // The bank closes the batch inside the 15-minute window: the trace is
    // now invisible and the inquiry answers not_found with batch 000002.
    await f.bca.closeBatch(f.terminalId);

    f.advance(60_000); // past saleTimeoutMs + grace, inside the 15-min window
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect(resolved.needsReconciliation).toBe(true);
    const rows = await rowsFor(first.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0]!.needs_reconciliation).toBe(true);

    await expect(
      pay(f, request(f, { reference: first.reference })),
    ).rejects.toMatchObject({ reason: "EDC_NEEDS_RECONCILIATION" });

    // No second sale reached the terminal, no second charge for X.
    expect(f.bca.callsFor(f.terminalId).sale).toBe(salesBefore + 1);
    expect(f.bca.chargedCount(f.terminalId)).toBe(chargedBefore + 1);
    const after = await rowsFor(first.reference);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("unknown");
  });

  it("B2 an unknown batch (first sale on the terminal) makes not_found untrusted: unknown and flagged, not failed", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_after_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    // No earlier row with a batch_no on this terminal: nothing to compare to.
    expect((await rowsFor(first.reference))[0]!.dispatch_batch_no).toBeNull();

    await f.bca.closeBatch(f.terminalId);

    f.advance(60_000); // past saleTimeoutMs + grace, inside the 15-min window
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

  it("B2 not_found with no batch change and no known batch is still unknown, not failed (never charged)", async () => {
    const f = await fixture();
    f.bca.next(f.terminalId, "timeout_before_charge");
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");

    f.advance(60_000); // past saleTimeoutMs + grace, inside the 15-min window
    const resolved = await f.agent.inquire(f.ctx, f.actor, refTo(tx.id));
    expect(resolved.status).toBe("unknown");
    expect(resolved.needsReconciliation).toBe(true);
    const rows = await rowsFor(first.reference);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(rows[0]!.needs_reconciliation).toBe(true);
  });

  it("B3 control: not_found in the same known batch inside the window is trusted: failed, and the retry is charged once", async () => {
    const f = await fixture();
    await settleOneApprovedSale(f);
    const chargedBefore = f.bca.chargedCount(f.terminalId);

    f.bca.next(f.terminalId, "timeout_before_charge"); // never charged, no close
    const first = request(f);
    const tx = await pay(f, first);
    expect(tx.status).toBe("unknown");
    expect(f.bca.chargedCount(f.terminalId)).toBe(chargedBefore);

    f.advance(60_000); // past saleTimeoutMs + grace, inside the 15-min window
    const retry = await pay(f, request(f, { reference: first.reference }));
    expect(retry.status).toBe("approved");
    expect(f.bca.chargedCount(f.terminalId)).toBe(chargedBefore + 1);
    const rows = await rowsFor(first.reference);
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "failed"]);
    expect(rows.every((r) => !r.needs_reconciliation)).toBe(true);
  });

  it("B4 dispatch_batch_no is stored at dispatch from the newest known batch of the terminal", async () => {
    const f = await fixture();

    // First sale: no known batch yet.
    const refA = refOf();
    expect((await pay(f, request(f, { reference: refA }))).status).toBe(
      "approved",
    );
    const [a] = await rowsFor(refA);
    expect(a!.dispatch_batch_no).toBeNull();
    expect(a!.batch_no).toBe("000001");

    // Same batch still open: the newest known batch is A's.
    await f.bca.closeBatch(f.terminalId);
    const refB = refOf();
    expect((await pay(f, request(f, { reference: refB }))).status).toBe(
      "approved",
    );
    const [b] = await rowsFor(refB);
    expect(b!.dispatch_batch_no).toBe("000001"); // batch at the last known sale
    expect(b!.batch_no).toBe("000002");

    // Newest row with a batch_no is now B's.
    const refC = refOf();
    expect((await pay(f, request(f, { reference: refC }))).status).toBe(
      "approved",
    );
    const [c] = await rowsFor(refC);
    expect(c!.dispatch_batch_no).toBe("000002");
    expect(c!.batch_no).toBe("000002");
  });
});
