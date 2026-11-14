// EDC failover wire marker (bead legend-r11em, branch fix/edc-failover-861;
// docs/briefs/861-edc-failover-r11em.md). Tier K / money. Founder rule: the
// guest is never charged twice and the outlet is never short; when unsure,
// REJECT (fail closed).
//
// Rule under test: `edc_transactions.sale_wire_open_at` says "a sale call may
// still be running on a terminal". It is set in the same statement that
// claims the dispatch (so it cannot be missing), cleared only when the sale
// call really ended, and a process that takes over an outlet may only clear
// markers whose sale is older than the late-response window.
//
//   861-A  the dispatch claim sets the marker together with `dispatched_at`.
//   861-B  a second agent instance (other process) that takes the outlet
//          while the first one's sale call still runs inside the window does
//          NOT clear the marker; reconcile and cash stay refused; when the
//          call settles the marker is cleared.
//   861-C  markers older than the window (or without a dispatch time) are
//          cleared by `start()` and by `recoverInFlight`; markers inside the
//          window are kept by both.
//   861-D  a normally answered sale (approved, declined) and a sale that was
//          never sent (owner check refused, NotSentError) leave no marker.
//   861-E  the card is never charged twice: while the marker is open no second
//          sale is dispatched, not by the same agent and not by the process
//          that took the outlet over.
//
// Assumptions (the brief does not fix these; also in the report):
// - Another process is simulated by a second `createEdcAgent`. The outlet
//   lock is a Postgres advisory lock held on a connection of the pool given
//   as `deps.pool`; the first agent gets its own pool (own application_name)
//   and the test kills that backend (`pg_terminate_backend`), which is what a
//   dead process / lost lock looks like to the database. The first agent's
//   adapter call keeps running in this process (the gate promise).
// - NotSentError (the owner check refused right before the terminal) is
//   provoked by killing the lock connection from a database trigger that fires
//   when the dispatch claim is written, then waiting, so that the check that
//   follows the claim finds the lock gone. Only observable results are
//   asserted: the adapter was never called, nothing was charged, no marker.
// - The late-response window is `EDC_LATE_RESPONSE_WINDOW_MS`; fixtures use
//   rows 15 minutes old ("older than the window") and 2 minutes old ("inside").
// - Fail-closed refusals are HTTP 409 (as EDC-01); the code is not asserted.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
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
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { roleTemplate } from "@starter/shared/access";
import {
  ecrResultSchema,
  type EcrSaleRequest,
  type EdcPaymentRequest,
  type EdcProvider,
} from "@starter/shared/edc";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { createAppPool } from "../db/role.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { EDC_LATE_RESPONSE_WINDOW_MS } from "../edge/edc/late-response.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const WINDOW_MINUTES = EDC_LATE_RESPONSE_WINDOW_MS / 60_000;
/** Older than the late-response window. */
const OUTSIDE_WINDOW = `${WINDOW_MINUTES + 5} minutes`;
/** Inside the late-response window. */
const INSIDE_WINDOW = "2 minutes";

const ids = {
  cashierRole: randomUUID(),
  ownerRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  device: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: Member;
let ownerUser: Member;
let ctx: ScopedTenantContext;
let terminalIdForDirectRows: string;

// ---- Receipt numbering double (same as the sibling EDC POS tests) ------------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

// ---- Database helpers --------------------------------------------------------

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  // The resolve route needs a session that verified its second factor.
  await verifySessionMfa(email);
  return { client, userId };
}

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const deviceToken = () =>
    signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId: ids.device,
    });
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: async (bill: Bill) => {
      const got = await who.client
        .get(`${base}/${bill.orderId}`)
        .set(headers)
        .set(originHeader);
      return send(`/${bill.orderId}/tenders`, {
        method: "cash",
        receivedIdr: bill.totalIdr,
        expectedStatus: got.body.data.status as string,
      });
    },
  };
}

type Bill = {
  orderId: string; // API (ULID) id
  orderUuid: string; // database id
  number: string;
  totalIdr: number;
};

async function newBill(): Promise<Bill> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  return {
    orderId,
    orderUuid: ulidToUuid(orderId),
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
  };
}

async function seedTerminal(): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-R11EM', 'Test EDC', 'lan', '10.0.0.9', $5, 'active')`,
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

type LedgerRow = {
  id: string;
  status: string;
  needs_reconciliation: boolean;
  dispatched_at: Date | null;
  approval_code: string | null;
  sale_wire_open_at: Date | null;
};

async function ledgerRows(reference: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT id, status, needs_reconciliation, dispatched_at, approval_code,
            sale_wire_open_at FROM edc_transactions
      WHERE tenant_id = $1 AND reference = $2 ORDER BY created_at, id`,
    [tenant.tenantId, reference],
  );
  return rows;
}

/**
 * A card ECR sale row written directly: status `unknown`, not flagged,
 * dispatched `dispatchedAgo` ago (null: never dispatched), with the wire
 * marker set to the same time (`markerAgo`, null: no marker).
 */
async function markedSale(input: {
  reference: string;
  amountIdr: number;
  dispatchedAgo: string | null;
  markerAgo: string | null;
}): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          needs_reconciliation, dispatched_at, sale_wire_open_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', 'unknown', 'sale', 'ecr', $8,
               false,
               CASE WHEN $9::text IS NULL THEN NULL ELSE now() - $9::interval END,
               CASE WHEN $10::text IS NULL THEN NULL ELSE now() - $10::interval END)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalIdForDirectRows,
        input.reference,
        randomUUID(),
        input.amountIdr,
        randomUUID().replaceAll("-", "").slice(0, 12),
        input.dispatchedAgo,
        input.markerAgo,
      ],
    ),
  );
  return id;
}

async function markerOf(id: string): Promise<Date | null> {
  const { rows } = await owner.query<{ sale_wire_open_at: Date | null }>(
    "SELECT sale_wire_open_at FROM edc_transactions WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, id],
  );
  return rows[0]!.sale_wire_open_at;
}

function resolve(edcTransactionId: string) {
  return ownerUser.client
    .post(
      `/api/payments/admin/edc/transactions/${encodeURIComponent(edcTransactionId)}/reconciliation`,
    )
    .set(headers)
    .set(originHeader)
    .send({
      outcome: "declined",
      evidence: {
        source: "terminal_receipt",
        note: "Struk terminal dicek: tidak ada penagihan kartu",
      },
    });
}

// ---- Agent and provider fixtures ---------------------------------------------

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];
const gates: Array<() => void> = [];
const lockPools: Pool[] = [];

// A cleanup step may hang on a connection the test killed on purpose.
const bounded = (work: Promise<unknown>) =>
  Promise.race([
    work.catch(() => undefined),
    new Promise((done) => setTimeout(done, 3_000)),
  ]);

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  for (const { agent: a, ctx: c } of started.splice(0))
    await bounded(a.stop(c));
  for (const lockPool of lockPools.splice(0)) await bounded(lockPool.end());
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  gates.push(open);
  return { open, promise };
}

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

function newAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
  pool?: Pool,
): ReturnType<typeof createEdcAgent> {
  const a = createEdcAgent({
    db,
    ...(pool ? { pool } : {}),
    registry: new EdcProviderRegistry().register(provider),
    saleTimeoutMs,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  started.push({ agent: a, ctx });
  return a;
}

async function startAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
): Promise<{
  agent: ReturnType<typeof createEdcAgent>;
  terminalId: string;
}> {
  const terminalId = await seedTerminal();
  const a = newAgent(provider, saleTimeoutMs);
  await a.start(ctx);
  return { agent: a, terminalId };
}

/**
 * An agent whose outlet lock sits on a connection of its own pool, so a test
 * can make that "process" lose the lock (`loseLock`) while its adapter call,
 * which lives in this process, keeps running.
 */
async function startLockedAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
): Promise<{
  agent: ReturnType<typeof createEdcAgent>;
  terminalId: string;
  loseLock: () => Promise<void>;
  appName: string;
}> {
  const appName = `edc861-${randomUUID().slice(0, 8)}`;
  const lockPool = createAppPool(env.APP_DATABASE_URL ?? env.DATABASE_URL, {
    max: 3,
    application_name: appName,
  });
  lockPools.push(lockPool);
  const noop = () => undefined;
  lockPool.on("error", noop);
  // The connection is killed on purpose while the agent holds it.
  const connect = lockPool.connect.bind(lockPool) as () => Promise<PoolClient>;
  (lockPool as unknown as { connect: () => Promise<PoolClient> }).connect =
    async () => {
      const client = await connect();
      client.on("error", noop);
      return client;
    };
  const terminalId = await seedTerminal();
  const a = newAgent(provider, saleTimeoutMs, lockPool);
  await a.start(ctx);
  const loseLock = async () => {
    await owner.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [appName],
    );
    await vi.waitFor(async () => {
      const { rowCount } = await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1",
        [appName],
      );
      expect(rowCount).toBe(0);
    });
  };
  return { agent: a, terminalId, loseLock, appName };
}

function saleRequest(bill: Bill, terminalId: string): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId,
    reference: bill.number,
    idempotencyKey: randomUUID(),
    amountIdr: idr(bill.totalIdr),
    method: "card",
  } as EdcPaymentRequest;
}

/** A provider whose sale call waits for a gate; counts the sale calls. */
function gatedProvider(
  sim: EcrSimulator,
  saleGate: { promise: Promise<void> },
) {
  const state = { saleCalls: 0 };
  const provider = passThrough(sim, {
    sale: async (r: EcrSaleRequest) => {
      state.saleCalls += 1;
      await saleGate.promise;
      return sim.sale(r);
    },
  });
  return { provider, state };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`r11em-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  const roles: [string, string, readonly string[]][] = [
    [
      ids.cashierRole,
      "R11EM Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
    ],
    [ids.ownerRole, "R11EM Owner", roleTemplate("owner").permissions],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "R11EM Kasir");
  ownerUser = await member(ids.ownerRole, "R11EM Owner");
  ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'R11EM Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await c.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-R11EM', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
  });
  terminalIdForDirectRows = await seedTerminal();
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Tests ------------------------------------------------------------------

describe("legend-r11em EDC failover wire marker", () => {
  it("861-A the dispatch claim sets the wire marker together with dispatched_at, before the adapter is called", async () => {
    const saleGate = gate();
    const sim = new EcrSimulator("bca");
    const bill = await newBill();
    const seenAtSale: { marker: Date | null; dispatchedAt: Date | null }[] = [];
    const provider = passThrough(sim, {
      sale: async (r: EcrSaleRequest) => {
        const [row] = await ledgerRows(bill.number);
        seenAtSale.push({
          marker: row?.sale_wire_open_at ?? null,
          dispatchedAt: row?.dispatched_at ?? null,
        });
        await saleGate.promise;
        return sim.sale(r);
      },
    });
    // A long sale timeout: the row stays `pending`, no timeout path involved.
    const { agent: edc, terminalId } = await startAgent(provider, 30_000);

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    await vi.waitFor(async () => {
      const rows = await ledgerRows(bill.number);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(seenAtSale).toHaveLength(1);
    });

    const [row] = await ledgerRows(bill.number);
    expect(
      row?.sale_wire_open_at,
      "the sale is on the wire but the wire marker is not set",
    ).not.toBeNull();
    expect(
      row!.sale_wire_open_at!.getTime(),
      "marker and dispatched_at were not written by the same claim",
    ).toBe(row!.dispatched_at!.getTime());
    // The adapter already saw the marker when it was called: it was written
    // before anything went to the terminal.
    expect(seenAtSale[0]!.marker).not.toBeNull();
    expect(seenAtSale[0]!.marker!.getTime()).toBe(
      seenAtSale[0]!.dispatchedAt!.getTime(),
    );

    // The call ends: approved, and the marker is cleared.
    saleGate.open();
    await selling;
    await vi.waitFor(async () => {
      const [after] = await ledgerRows(bill.number);
      expect(after?.status).toBe("approved");
      expect(after?.sale_wire_open_at).toBeNull();
    });
  });

  it("861-B a second agent instance that takes the outlet while the first one's sale call still runs inside the window keeps the marker; reconcile and cash stay refused", async () => {
    const saleGate = gate();
    const sim = new EcrSimulator("bca");
    const first = gatedProvider(sim, saleGate);
    const {
      agent: edc1,
      terminalId,
      loseLock,
    } = await startLockedAgent(first.provider, 100);
    const bill = await newBill();

    const selling = edc1.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    // The first agent gives up waiting; its adapter call is still running.
    await vi.waitFor(async () => {
      const [row] = await ledgerRows(bill.number);
      expect(first.state.saleCalls).toBe(1);
      expect(row?.status).toBe("unknown");
      expect(row?.sale_wire_open_at).not.toBeNull();
    });
    const rowId = (await ledgerRows(bill.number))[0]!.id;

    // The first process loses the outlet; another process takes it over.
    await loseLock();
    const second = gatedProvider(new EcrSimulator("bca"), saleGate);
    const edc2 = newAgent(second.provider, 100);
    await edc2.start(ctx);

    expect(
      await markerOf(rowId),
      "the new process cleared the marker of a sale call that is still running",
    ).not.toBeNull();
    const byHand = await resolve(rowId);
    expect(
      byHand.status,
      `declined accepted while a sale call is still on the wire: ${JSON.stringify(byHand.body)}`,
    ).toBe(409);
    const cash = await pos().cash(bill);
    expect(
      cash.status,
      `cash accepted while a sale call is still on the wire: ${JSON.stringify(cash.body)}`,
    ).toBe(409);

    // The first call finally settles: the card was charged once, marker cleared.
    saleGate.open();
    await selling.catch(() => undefined);
    await vi.waitFor(
      async () => {
        expect(await markerOf(rowId)).toBeNull();
      },
      { timeout: 5_000 },
    );
    expect(sim.chargedCount(terminalId)).toBe(1);
  });

  describe("861-C markers older than the late-response window", () => {
    it("start() clears a marker older than the window and a marker without a dispatch time", async () => {
      const old = await markedSale({
        reference: (await newBill()).number,
        amountIdr: KOPI_IDR,
        dispatchedAgo: OUTSIDE_WINDOW,
        markerAgo: OUTSIDE_WINDOW,
      });
      const neverDispatched = await markedSale({
        reference: (await newBill()).number,
        amountIdr: KOPI_IDR,
        dispatchedAgo: null,
        markerAgo: OUTSIDE_WINDOW,
      });
      await startAgent(passThrough(new EcrSimulator("bca")), 5_000);

      expect(
        await markerOf(old),
        "a marker older than the window survived start()",
      ).toBeNull();
      expect(
        await markerOf(neverDispatched),
        "a marker on a sale that was never dispatched survived start()",
      ).toBeNull();
    });

    it("start() keeps a marker inside the window", async () => {
      const fresh = await markedSale({
        reference: (await newBill()).number,
        amountIdr: KOPI_IDR,
        dispatchedAgo: INSIDE_WINDOW,
        markerAgo: INSIDE_WINDOW,
      });
      await startAgent(passThrough(new EcrSimulator("bca")), 5_000);

      expect(
        await markerOf(fresh),
        "start() cleared the marker of a sale another process may still run",
      ).not.toBeNull();
    });

    it("recoverInFlight clears a marker older than the window on a running agent", async () => {
      const { agent: edc } = await startAgent(
        passThrough(new EcrSimulator("bca")),
        5_000,
      );
      // The process that held the sale died after this agent started.
      const old = await markedSale({
        reference: (await newBill()).number,
        amountIdr: KOPI_IDR,
        dispatchedAgo: OUTSIDE_WINDOW,
        markerAgo: OUTSIDE_WINDOW,
      });
      expect(await markerOf(old)).not.toBeNull();

      await edc.recoverInFlight(ctx);

      expect(
        await markerOf(old),
        "recoverInFlight left a marker older than the window",
      ).toBeNull();
    });

    it("recoverInFlight keeps a marker inside the window", async () => {
      const { agent: edc } = await startAgent(
        passThrough(new EcrSimulator("bca")),
        5_000,
      );
      const fresh = await markedSale({
        reference: (await newBill()).number,
        amountIdr: KOPI_IDR,
        dispatchedAgo: INSIDE_WINDOW,
        markerAgo: INSIDE_WINDOW,
      });

      await edc.recoverInFlight(ctx);

      expect(
        await markerOf(fresh),
        "recoverInFlight cleared the marker of a sale that may still run",
      ).not.toBeNull();
    });
  });

  describe("861-D a sale whose call ended leaves no marker", () => {
    it("an approved sale", async () => {
      const bill = await newBill();
      const { agent: edc, terminalId } = await startAgent(
        passThrough(new EcrSimulator("bca")),
        5_000,
      );
      const answer = await edc.requestPayment(
        ctx,
        cashier.userId,
        saleRequest(bill, terminalId),
      );
      expect(answer.status).toBe("approved");
      const [row] = await ledgerRows(bill.number);
      expect(row?.status).toBe("approved");
      expect(row?.dispatched_at).not.toBeNull();
      expect(row?.sale_wire_open_at).toBeNull();
    });

    it("a declined sale", async () => {
      const bill = await newBill();
      const sim = new EcrSimulator("bca");
      const provider = passThrough(sim, {
        sale: async (r: EcrSaleRequest) =>
          ecrResultSchema.parse({
            outcome: "declined",
            responseCode: "51",
            message: "Declined",
            amountIdr: r.amountIdr,
            trace: r.trace,
          }),
      });
      const { agent: edc, terminalId } = await startAgent(provider, 5_000);
      await edc
        .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
        .catch(() => undefined);
      const [row] = await ledgerRows(bill.number);
      expect(row?.status).toBe("declined");
      expect(row?.sale_wire_open_at).toBeNull();
    });

    it("a sale the owner check refused right before the terminal (NotSentError): nothing is sent and no marker is left", async () => {
      const sim = new EcrSimulator("bca");
      const state = { saleCalls: 0 };
      const provider = passThrough(sim, {
        sale: async (r: EcrSaleRequest) => {
          state.saleCalls += 1;
          return sim.sale(r);
        },
      });
      const {
        agent: edc,
        terminalId,
        appName,
      } = await startLockedAgent(provider, 5_000);
      const bill = await newBill();
      expect(bill.number).toMatch(/^[A-Za-z0-9-]+$/);
      const fn = `edc861_kill_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      // When the dispatch claim is written, the outlet lock connection dies
      // and the claim waits, so the owner check that follows finds it gone.
      await owner.query(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = '${appName}';
          PERFORM pg_sleep(0.5);
          RETURN NEW;
        END $$`);
      await owner.query(`
        CREATE TRIGGER ${fn} AFTER UPDATE ON edc_transactions
          FOR EACH ROW
          WHEN (OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL
                AND NEW.reference = '${bill.number}')
          EXECUTE FUNCTION ${fn}()`);
      try {
        const outcome = await edc
          .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
          .then(
            (tx) => ({ rejected: false as const, tx }),
            (error: unknown) => ({ rejected: true as const, error }),
          );
        expect(
          outcome.rejected,
          "the sale went on although the outlet lock was lost before sending",
        ).toBe(true);
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON edc_transactions`);
        await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }

      expect(state.saleCalls, "the terminal was called").toBe(0);
      expect(sim.chargedCount(terminalId)).toBe(0);
      for (const row of await ledgerRows(bill.number)) {
        expect(
          row.sale_wire_open_at,
          "a sale that never reached the terminal left a wire marker",
        ).toBeNull();
      }
    });
  });

  describe("861-E the card is never charged twice while the marker is open", () => {
    it("the same agent dispatches no second sale for the bill", async () => {
      const saleGate = gate();
      const sim = new EcrSimulator("bca");
      const { provider, state } = gatedProvider(sim, saleGate);
      const { agent: edc, terminalId } = await startAgent(provider, 100);
      const bill = await newBill();

      const selling = edc.requestPayment(
        ctx,
        cashier.userId,
        saleRequest(bill, terminalId),
      );
      selling.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await ledgerRows(bill.number);
        expect(state.saleCalls).toBe(1);
        expect(row?.status).toBe("unknown");
        expect(row?.sale_wire_open_at).not.toBeNull();
      });

      // The cashier tries again with a fresh idempotency key.
      await edc
        .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
        .catch(() => undefined);
      expect(
        state.saleCalls,
        "a second sale reached the terminal while the first is still on the wire",
      ).toBe(1);

      saleGate.open();
      await selling.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await ledgerRows(bill.number);
        expect(row?.sale_wire_open_at).toBeNull();
      });
      expect(sim.chargedCount(terminalId)).toBe(1);
    });

    it("the process that took the outlet over dispatches no second sale for the bill", async () => {
      const saleGate = gate();
      const sim = new EcrSimulator("bca");
      const first = gatedProvider(sim, saleGate);
      const {
        agent: edc1,
        terminalId,
        loseLock,
      } = await startLockedAgent(first.provider, 100);
      const bill = await newBill();

      const selling = edc1.requestPayment(
        ctx,
        cashier.userId,
        saleRequest(bill, terminalId),
      );
      selling.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await ledgerRows(bill.number);
        expect(first.state.saleCalls).toBe(1);
        expect(row?.sale_wire_open_at).not.toBeNull();
      });

      await loseLock();
      const second = gatedProvider(new EcrSimulator("bca"), saleGate);
      const edc2 = newAgent(second.provider, 100);
      await edc2.start(ctx);

      // The new process is asked to charge the same bill again.
      await edc2
        .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
        .catch(() => undefined);
      expect(
        second.state.saleCalls,
        "the new process sent a second sale while the first call may still charge",
      ).toBe(0);

      saleGate.open();
      await selling.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const rows = await ledgerRows(bill.number);
          expect(rows.every((r) => r.sale_wire_open_at === null)).toBe(true);
        },
        { timeout: 5_000 },
      );
      expect(sim.chargedCount(terminalId)).toBe(1);
    });
  });
});
