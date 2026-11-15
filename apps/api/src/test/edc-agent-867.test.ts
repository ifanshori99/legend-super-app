// EDC agent lock heartbeat and live-call count (beads legend-agran and
// legend-h4c2f, branch fix/edc-agent-867; docs/briefs/sub-edc-agent-867.md).
// Tier K / money. Founder rule: the guest is never charged twice and the
// outlet is never short; when unsure, REJECT (fail closed).
//
// legend-agran: the outlet lock sits on a dedicated connection. A connection
// that dies silently (NAT drop, host crash) raises no 'error'/'end', so the
// lock is lost unnoticed. New deps: `lockHeartbeatMs`, `lockHeartbeatTimeoutMs`
// (0 = off). The agent runs `SELECT 1` on the lock connection; a failed or
// timed out probe is a lost lock (same path as 861-G: release the connection,
// fail-stop through `onFatal` only when a sale call is still on the wire).
//
//   867-A1  probe never settles, a sale call is alive: onFatal once.
//   867-A2  probe never settles, no sale call: lock connection given back,
//           outlet refuses sales, onFatal NOT called.
//   867-A3  healthy (and slow-but-in-time) probes disturb nothing.
//   867-A4  probes do not pile up while one is pending; none after the loss.
//   867-A5  stop() ends the heartbeat.
//   867-A6  lockHeartbeatMs = 0 turns it off.
//   867-A7  probe that rejects counts as lost (live call: onFatal once).
//   867-A8  one failed probe is not a lost lock; two in a row are.
//   867-A9  onOutletLost: called without a live call, not with one.
//   867-A10 an unlock that never answers does not hang stop().
//
// legend-h4c2f: only a call still waiting for the adapter is "live". Once the
// terminal answered, the DB write of the approval evidence must not trigger
// fail-stop, and must be saved.
//
//   867-H1  lock lost after the adapter answered, DB write still running: no
//           onFatal, row ends approved (not unknown).
//   867-H2  lock lost while the adapter still waits: onFatal still called.
//   867-H3  stop() keeps the outlet lock until the evidence write is saved.
//
// "Jangan sampai rugi" (money rule) proofs:
//   867-M1  after a heartbeat-detected loss no second sale is sent (old or new
//           process).
//   867-M2  after it, a process taking the outlet inside the late-response
//           window keeps the wire marker; reconcile and cash stay refused.
//   867-M3  heartbeat-detected loss while the adapter answered and the DB write
//           runs: evidence saved, row approved, no fail-stop.
//
// Assumptions (the brief does not fix these; also in the report):
// - Heartbeat is exactly `SELECT 1` on the lock connection (per the brief).
//   A silently dead connection is simulated by wrapping `query` of the lock
//   pool's clients: a probe is counted, then answered normally, delayed, never
//   answered ("hang") or rejected ("fail"). Nothing else is intercepted.
// - A "process exit" after fail-stop is simulated by killing the lock
//   connection's backend (what the OS does when the process dies).
// - The fail-stop `onFatal` of H1/M3 simulates process.exit by cancelling the
//   running approval write (pg_terminate_backend of the sleeping statement),
//   so "row approved" really proves the write was not cut.
// - The approval write is slowed with a trigger (pg_sleep) that fires when the
//   row first becomes `approved`.
// - After the lock is lost with no live call the outlet is "not ready":
//   requestPayment rejects and the adapter is not called (fail closed).
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
import { createEdcAgent, type EdcAgentDeps } from "../edge/edc/agent.ts";
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
/** Heartbeat interval and probe timeout used by the tests (ms). */
const HB_MS = 40;
const HB_TIMEOUT_MS = 150;
/** How long the slowed approval write runs (ms). */
const SLOW_WRITE_MS = 1_500;

/** New deps from the brief; not in `EdcAgentDeps` yet. */
type HeartbeatDeps = {
  lockHeartbeatMs?: number;
  lockHeartbeatTimeoutMs?: number;
};
type AgentExtra = Partial<EdcAgentDeps> & HeartbeatDeps;

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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
  await verifySessionMfa(email);
  return { client, userId };
}

type Bill = {
  orderId: string; // API (ULID) id
  orderUuid: string; // database id
  number: string;
  totalIdr: number;
};

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
       VALUES ($1, $2, $3, 'bca', $4, 'MID-A867', 'Test EDC', 'lan', '10.0.0.9', $5, 'active')`,
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
  sale_wire_open_at: Date | null;
};

async function ledgerRows(reference: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT id, status, needs_reconciliation, dispatched_at,
            sale_wire_open_at FROM edc_transactions
      WHERE tenant_id = $1 AND reference = $2 ORDER BY created_at, id`,
    [tenant.tenantId, reference],
  );
  return rows;
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

/** Advisory locks held by the backends of one application_name. */
async function advisoryLocksHeldBy(appName: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = $1`,
    [appName],
  );
  return Number(rows[0]!.n);
}

/**
 * Slows the DB write that records the approval: a trigger sleeps when the row
 * of `reference` first becomes `approved`. Returns the cleanup.
 */
async function slowApprovalWrite(
  reference: string,
): Promise<() => Promise<void>> {
  const fn = `edc867_slow_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await owner.query(`
    CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(${SLOW_WRITE_MS / 1000});
      RETURN NEW;
    END $$`);
  await owner.query(`
    CREATE TRIGGER ${fn} AFTER UPDATE ON edc_transactions
      FOR EACH ROW
      WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
            AND NEW.reference = '${reference}')
      EXECUTE FUNCTION ${fn}()`);
  return async () => {
    await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON edc_transactions`);
    await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  };
}

async function waitForSlowWriteRunning() {
  await vi.waitFor(
    async () => {
      const { rows } = await owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep'",
      );
      expect(
        Number(rows[0]!.n),
        "the approval write never started",
      ).toBeGreaterThanOrEqual(1);
    },
    { timeout: 5_000 },
  );
}

/** What a process exit does to a running approval write: it is cut. */
function simulateExitCuttingWrites() {
  void owner.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event = 'PgSleep'",
  );
}

// ---- Agent and provider fixtures ---------------------------------------------

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];
const gates: Array<() => void> = [];
const lockPools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];

type FatalInfo = { tenantId: string; outletId: string; liveCalls: number };
const fatalSpies = new WeakMap<object, ReturnType<typeof vi.fn>>();
function fatalOf(a: ReturnType<typeof createEdcAgent>) {
  return fatalSpies.get(a)!;
}

// A cleanup step may hang on a connection the test killed on purpose.
const bounded = (work: Promise<unknown>) =>
  Promise.race([work.catch(() => undefined), sleep(3_000)]);

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  for (const clean of cleanups.splice(0)) await bounded(clean());
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

function newAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
  pool?: Pool,
  extra: AgentExtra = {},
): ReturnType<typeof createEdcAgent> {
  const impl =
    (extra.onFatal as ((info: FatalInfo) => void) | undefined) ??
    (() => undefined);
  const onFatal = vi.fn<(info: FatalInfo) => void>(impl);
  const a = createEdcAgent({
    db,
    ...(pool ? { pool } : {}),
    ...extra,
    onFatal,
    registry: new EdcProviderRegistry().register(provider),
    saleTimeoutMs,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  } as EdcAgentDeps);
  started.push({ agent: a, ctx });
  fatalSpies.set(a, onFatal);
  return a;
}

/** Counts and steers the `SELECT 1` heartbeat probes on a lock connection. */
type Probe = {
  /** Number of `SELECT 1` probes sent on the lock connection(s). */
  selectOnes: number;
  /** ok: answered normally; hang: never answered; fail: rejected. */
  mode: "ok" | "hang" | "fail";
  /** Extra delay before a normal answer (ms). */
  delayMs: number;
  /** The next this-many probes are rejected, then `mode` applies again. */
  failNext: number;
  /** `pg_advisory_unlock` never answers (a connection dead for good). */
  unlockHang: boolean;
};

/**
 * An agent whose outlet lock sits on a connection of its own pool. `probe`
 * sees every `SELECT 1` on that connection and can make the connection look
 * silently dead (the lock stays held in the database, no 'error'/'end').
 * `loseLock` kills the backend (a dead process) the loud way.
 */
async function startLockedAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
  options: { extra?: AgentExtra; probeMode?: Probe["mode"] } = {},
) {
  const appName = `edc867-${randomUUID().slice(0, 8)}`;
  const lockPool = createAppPool(env.APP_DATABASE_URL ?? env.DATABASE_URL, {
    max: 3,
    application_name: appName,
  });
  lockPools.push(lockPool);
  const noop = () => undefined;
  lockPool.on("error", noop);
  const probe: Probe = {
    selectOnes: 0,
    mode: options.probeMode ?? "ok",
    delayMs: 0,
    failNext: 0,
    unlockHang: false,
  };
  const wrapped = new WeakSet<object>();
  const connect = lockPool.connect.bind(lockPool) as () => Promise<PoolClient>;
  (lockPool as unknown as { connect: () => Promise<PoolClient> }).connect =
    async () => {
      const client = await connect();
      client.on("error", noop);
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const real = client.query.bind(client) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        (
          client as unknown as { query: (...args: unknown[]) => unknown }
        ).query = (...args: unknown[]) => {
          const first = args[0];
          const text =
            typeof first === "string"
              ? first
              : (first as { text?: string } | undefined)?.text;
          if (
            probe.unlockHang &&
            typeof text === "string" &&
            /pg_advisory_unlock/i.test(text)
          )
            return new Promise(() => undefined);
          if (
            typeof text === "string" &&
            /^\s*select\s+1\s*;?\s*$/i.test(text)
          ) {
            probe.selectOnes += 1;
            if (probe.failNext > 0) {
              probe.failNext -= 1;
              return Promise.reject(new Error("heartbeat probe failed"));
            }
            if (probe.mode === "hang") return new Promise(() => undefined);
            if (probe.mode === "fail")
              return Promise.reject(new Error("heartbeat probe failed"));
            if (probe.delayMs > 0)
              return sleep(probe.delayMs).then(() => real(...args));
          }
          return real(...args);
        };
      }
      return client;
    };
  const terminalId = await seedTerminal();
  const a = newAgent(provider, saleTimeoutMs, lockPool, options.extra ?? {});
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
  return { agent: a, terminalId, loseLock, appName, lockPool, probe };
}

const HEARTBEAT: AgentExtra = {
  lockHeartbeatMs: HB_MS,
  lockHeartbeatTimeoutMs: HB_TIMEOUT_MS,
};

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

/**
 * A heartbeat agent with a sale call that timed out but is still running on
 * the terminal (row `unknown`, marker set). The heartbeat is healthy until the
 * test flips `probe.mode`.
 */
async function lockedAgentWithLiveCall(extra: AgentExtra = HEARTBEAT) {
  const saleGate = gate();
  const sim = new EcrSimulator("bca");
  const first = gatedProvider(sim, saleGate);
  const locked = await startLockedAgent(first.provider, 100, { extra });
  const bill = await newBill();
  const selling = locked.agent.requestPayment(
    ctx,
    cashier.userId,
    saleRequest(bill, locked.terminalId),
  );
  selling.catch(() => undefined);
  await vi.waitFor(async () => {
    const [row] = await ledgerRows(bill.number);
    expect(first.state.saleCalls).toBe(1);
    expect(row?.status).toBe("unknown");
    expect(row?.sale_wire_open_at).not.toBeNull();
  });
  const rowId = (await ledgerRows(bill.number))[0]!.id;
  return { ...locked, first, sim, saleGate, bill, rowId, selling };
}

/**
 * An agent with a sale call waiting for the adapter (long sale timeout, row
 * `pending`) and a slow approval write armed for the bill. `answer()` lets the
 * adapter answer; the write then runs for SLOW_WRITE_MS.
 */
async function lockedAgentWithSlowApproval(
  extra: AgentExtra,
  onFatal?: (info: FatalInfo) => void,
  /**
   * true: the sale call times out first (row `unknown`) and the terminal's
   * answer arrives late, the path where the evidence is written after the
   * caller gave up.
   */
  lateAnswer = false,
) {
  const saleGate = gate();
  const sim = new EcrSimulator("bca");
  const first = gatedProvider(sim, saleGate);
  const locked = await startLockedAgent(
    first.provider,
    lateAnswer ? 100 : 30_000,
    {
      extra: { ...extra, ...(onFatal ? { onFatal } : {}) },
    },
  );
  const bill = await newBill();
  cleanups.push(await slowApprovalWrite(bill.number));
  const selling = locked.agent.requestPayment(
    ctx,
    cashier.userId,
    saleRequest(bill, locked.terminalId),
  );
  selling.catch(() => undefined);
  await vi.waitFor(async () => {
    const [row] = await ledgerRows(bill.number);
    expect(first.state.saleCalls).toBe(1);
    expect(row?.status).toBe(lateAnswer ? "unknown" : "pending");
    expect(row?.sale_wire_open_at).not.toBeNull();
  });
  return {
    ...locked,
    first,
    sim,
    bill,
    selling,
    /** The terminal answers; wait until the evidence write is running. */
    answer: async () => {
      saleGate.open();
      await waitForSlowWriteRunning();
    },
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`a867-${randomUUID().slice(0, 6)}`);
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
      "A867 Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
    ],
    [ids.ownerRole, "A867 Owner", roleTemplate("owner").permissions],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "A867 Kasir");
  ownerUser = await member(ids.ownerRole, "A867 Owner");
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
       VALUES ($1, $2, $3, 'A867 Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-A867', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

describe("legend-agran EDC agent lock heartbeat", () => {
  it("867-A1 probe never settles while a sale call is alive: onFatal is called once with the live call count", async () => {
    const { agent: edc1, probe } = await lockedAgentWithLiveCall();
    expect(fatalOf(edc1)).not.toHaveBeenCalled();

    // The lock connection dies silently: no 'error', no 'end', no answer.
    probe.mode = "hang";

    await vi.waitFor(
      () => {
        expect(
          fatalOf(edc1),
          "a silently dead lock connection was never noticed (no heartbeat)",
        ).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    await sleep(400);
    expect(fatalOf(edc1)).toHaveBeenCalledTimes(1);
    const info = fatalOf(edc1).mock.calls[0]![0] as FatalInfo;
    expect(info.liveCalls).toBeGreaterThanOrEqual(1);
    expect(typeof info.tenantId).toBe("string");
    expect(typeof info.outletId).toBe("string");
  });

  it("867-A2 probe never settles with no sale call alive: the lock connection goes back, the outlet refuses sales, onFatal is not called", async () => {
    const sim = new EcrSimulator("bca");
    const state = { saleCalls: 0 };
    const provider = passThrough(sim, {
      sale: async (r: EcrSaleRequest) => {
        state.saleCalls += 1;
        return sim.sale(r);
      },
    });
    const {
      agent: edc1,
      terminalId,
      lockPool,
      probe,
    } = await startLockedAgent(provider, 5_000, { extra: HEARTBEAT });
    expect(lockPool.totalCount).toBeGreaterThanOrEqual(1);

    probe.mode = "hang";

    await vi.waitFor(
      () => {
        expect(
          lockPool.totalCount,
          "the dead lock connection was never given back to the pool (no heartbeat timeout)",
        ).toBe(0);
      },
      { timeout: 5_000 },
    );
    await sleep(300);
    expect(
      fatalOf(edc1),
      "the process was stopped although no sale call was alive",
    ).not.toHaveBeenCalled();

    // Outlet not ready: a sale is refused and never reaches the terminal.
    const bill = await newBill();
    const outcome = await edc1
      .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
      .then(
        () => ({ rejected: false as const }),
        () => ({ rejected: true as const }),
      );
    expect(outcome.rejected, "a sale went on without the outlet lock").toBe(
      true,
    );
    expect(state.saleCalls).toBe(0);
    expect(sim.chargedCount(terminalId)).toBe(0);
  });

  it("867-A3 healthy probes (also slow but in time) disturb nothing", async () => {
    const sim = new EcrSimulator("bca");
    const {
      agent: edc1,
      terminalId,
      lockPool,
      probe,
    } = await startLockedAgent(passThrough(sim), 5_000, { extra: HEARTBEAT });

    await vi.waitFor(
      () => {
        expect(
          probe.selectOnes,
          "no heartbeat probe was sent on the lock connection",
        ).toBeGreaterThanOrEqual(3);
      },
      { timeout: 5_000 },
    );
    // A slow answer inside the timeout is still healthy.
    probe.delayMs = HB_TIMEOUT_MS / 3;
    const before = probe.selectOnes;
    await vi.waitFor(
      () => expect(probe.selectOnes).toBeGreaterThanOrEqual(before + 2),
      { timeout: 5_000 },
    );
    await sleep(HB_TIMEOUT_MS * 2);

    expect(fatalOf(edc1)).not.toHaveBeenCalled();
    expect(lockPool.totalCount).toBeGreaterThanOrEqual(1);
    const bill = await newBill();
    const paid = await edc1.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    expect(paid.status).toBe("approved");
    expect(sim.chargedCount(terminalId)).toBe(1);
  });

  it("867-A4 probes do not pile up while one is pending, and none are sent after the lock is lost", async () => {
    const sim = new EcrSimulator("bca");
    // Long timeout: the pending probe is still pending when we count.
    const {
      agent: edc1,
      lockPool,
      probe,
    } = await startLockedAgent(passThrough(sim), 5_000, {
      extra: { lockHeartbeatMs: 20, lockHeartbeatTimeoutMs: 1_200 },
      probeMode: "hang",
    });

    await vi.waitFor(() => expect(probe.selectOnes).toBeGreaterThanOrEqual(1), {
      timeout: 5_000,
    });
    await sleep(400); // ~20 intervals while the first probe is pending
    expect(
      probe.selectOnes,
      "a new probe was sent while the previous one had not settled",
    ).toBe(1);

    await vi.waitFor(() => expect(lockPool.totalCount).toBe(0), {
      timeout: 5_000,
    });
    const afterLoss = probe.selectOnes;
    await sleep(300);
    expect(probe.selectOnes, "probes continue after the lock was lost").toBe(
      afterLoss,
    );
    expect(fatalOf(edc1)).not.toHaveBeenCalled();
  });

  it("867-A5 stop() ends the heartbeat", async () => {
    const sim = new EcrSimulator("bca");
    const { agent: edc1, probe } = await startLockedAgent(
      passThrough(sim),
      5_000,
      {
        extra: HEARTBEAT,
      },
    );
    await vi.waitFor(() => expect(probe.selectOnes).toBeGreaterThanOrEqual(1), {
      timeout: 5_000,
    });

    await edc1.stop(ctx);
    const afterStop = probe.selectOnes;
    await sleep(HB_MS * 8);

    expect(probe.selectOnes, "the heartbeat kept probing after stop()").toBe(
      afterStop,
    );
  });

  it("867-A6 lockHeartbeatMs = 0 turns the heartbeat off", async () => {
    // Guard: passes before the feature exists; must stay green after it.
    const sim = new EcrSimulator("bca");
    const {
      agent: edc1,
      lockPool,
      probe,
    } = await startLockedAgent(passThrough(sim), 5_000, {
      extra: { lockHeartbeatMs: 0, lockHeartbeatTimeoutMs: HB_TIMEOUT_MS },
    });
    await sleep(500);
    expect(probe.selectOnes).toBe(0);
    expect(fatalOf(edc1)).not.toHaveBeenCalled();
    expect(lockPool.totalCount).toBeGreaterThanOrEqual(1);
  });

  it("867-A7 a probe that fails counts as a lost lock: onFatal once with a live call", async () => {
    const { agent: edc1, probe } = await lockedAgentWithLiveCall();
    expect(fatalOf(edc1)).not.toHaveBeenCalled();

    probe.mode = "fail";

    await vi.waitFor(
      () => {
        expect(
          fatalOf(edc1),
          "a failing heartbeat probe was not treated as a lost lock",
        ).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    await sleep(300);
    expect(fatalOf(edc1)).toHaveBeenCalledTimes(1);
    expect(
      (fatalOf(edc1).mock.calls[0]![0] as FatalInfo).liveCalls,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("legend-agran ronde 2: false positives, release timeout, onOutletLost", () => {
  it("867-A8 one failed probe is not a lost lock (a good probe resets the count); two failed probes in a row are", async () => {
    const lost =
      vi.fn<(info: { tenantId: string; outletId: string }) => void>();
    const { probe, lockPool } = await startLockedAgent(
      passThrough(new EcrSimulator("bca")),
      5_000,
      { extra: { ...HEARTBEAT, onOutletLost: lost } },
    );

    // One failure, then healthy again, three times over: never lost.
    for (let round = 0; round < 3; round += 1) {
      const before = probe.selectOnes;
      probe.failNext = 1;
      await vi.waitFor(
        () => expect(probe.selectOnes).toBeGreaterThanOrEqual(before + 2),
        { timeout: 5_000 },
      );
    }
    expect(
      lost,
      "a single failed probe was taken for a lost lock",
    ).not.toHaveBeenCalled();
    expect(lockPool.totalCount).toBeGreaterThanOrEqual(1);

    // Two in a row: lost.
    probe.failNext = 2;
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(lockPool.totalCount).toBe(0);
  });

  it("867-A9 lock lost with no live call: onOutletLost once with the outlet, no onFatal; with a live call only onFatal", async () => {
    const lost =
      vi.fn<(info: { tenantId: string; outletId: string }) => void>();
    const idle = await startLockedAgent(
      passThrough(new EcrSimulator("bca")),
      5_000,
      { extra: { ...HEARTBEAT, onOutletLost: lost } },
    );
    idle.probe.mode = "hang";
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await sleep(400);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toEqual({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
    });
    expect(fatalOf(idle.agent)).not.toHaveBeenCalled();

    const lostWithCall =
      vi.fn<(info: { tenantId: string; outletId: string }) => void>();
    const { agent: edc1, probe } = await lockedAgentWithLiveCall({
      ...HEARTBEAT,
      onOutletLost: lostWithCall,
    });
    probe.mode = "hang";
    await vi.waitFor(() => expect(fatalOf(edc1)).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await sleep(300);
    expect(
      lostWithCall,
      "onOutletLost was called although a sale call was on the wire",
    ).not.toHaveBeenCalled();
  });

  it("867-A10 an unlock that never answers does not hang stop(): the connection is destroyed and the lock freed", async () => {
    const {
      agent: edc1,
      probe,
      lockPool,
      appName,
    } = await startLockedAgent(passThrough(new EcrSimulator("bca")), 5_000, {
      extra: { lockHeartbeatMs: 0, lockHeartbeatTimeoutMs: 200 },
    });
    probe.unlockHang = true;

    const started = Date.now();
    await edc1.stop(ctx);
    expect(
      Date.now() - started,
      "stop() waited for a dead unlock",
    ).toBeLessThan(3_000);
    await vi.waitFor(
      async () => {
        const { rowCount } = await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1",
          [appName],
        );
        expect(rowCount, "the lock connection was not destroyed").toBe(0);
      },
      { timeout: 5_000 },
    );
    expect(lockPool.totalCount).toBe(0);
  });
});

describe("legend-h4c2f only calls still waiting for the adapter are live", () => {
  it("867-H1 lock lost after the adapter answered while the evidence write still runs: no onFatal, the row ends approved", async () => {
    // onFatal simulates process.exit: the running write would be cut.
    const {
      agent: edc1,
      loseLock,
      selling,
      bill,
      sim,
      terminalId,
      answer,
    } = await lockedAgentWithSlowApproval({}, simulateExitCuttingWrites);

    await answer();
    await loseLock();
    await sleep(500);

    expect(
      fatalOf(edc1),
      "fail-stop fired for a call the terminal already answered; the evidence write would be cut",
    ).not.toHaveBeenCalled();

    const tx = await selling.catch((error: unknown) => error);
    expect(
      (tx as { status?: string }).status,
      `the approval was not returned: ${String(tx)}`,
    ).toBe("approved");
    const [row] = await ledgerRows(bill.number);
    expect(row?.status, "approval evidence was not saved").toBe("approved");
    expect(row?.sale_wire_open_at).toBeNull();
    expect(sim.chargedCount(terminalId)).toBe(1);
  });

  it("867-H1b same, when the terminal answers late (the sale call timed out first, row unknown): no onFatal, the row ends approved", async () => {
    const {
      agent: edc1,
      loseLock,
      bill,
      sim,
      terminalId,
      answer,
    } = await lockedAgentWithSlowApproval({}, simulateExitCuttingWrites, true);

    await answer();
    await loseLock();
    await sleep(500);

    expect(
      fatalOf(edc1),
      "fail-stop fired for a call the terminal already answered; the evidence write would be cut",
    ).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        const [row] = await ledgerRows(bill.number);
        expect(row?.status, "approval evidence was not saved").toBe("approved");
        expect(row?.sale_wire_open_at).toBeNull();
      },
      { timeout: 8_000 },
    );
    expect(sim.chargedCount(terminalId)).toBe(1);
  });

  it("867-H2 lock lost while the adapter still waits: onFatal is still called with the live call", async () => {
    // Guard: passes today; the fix must keep a waiting adapter call live.
    const { agent: edc1, loseLock } = await lockedAgentWithSlowApproval({});

    await loseLock();

    await vi.waitFor(
      () => {
        expect(
          fatalOf(edc1),
          "the process kept running after it lost the lock with the terminal still waiting",
        ).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    await sleep(300);
    expect(fatalOf(edc1)).toHaveBeenCalledTimes(1);
    expect(
      (fatalOf(edc1).mock.calls[0]![0] as FatalInfo).liveCalls,
    ).toBeGreaterThanOrEqual(1);
  });

  it("867-H3 stop() keeps the outlet lock until the evidence write is saved", async () => {
    // Guard: the drain must still wait for the DB write after the fix.
    const {
      agent: edc1,
      appName,
      selling,
      bill,
      answer,
    } = await lockedAgentWithSlowApproval({});
    expect(await advisoryLocksHeldBy(appName)).toBeGreaterThanOrEqual(1);

    await answer();
    const state = { stopped: false };
    const stopping = edc1.stop(ctx).then(() => {
      state.stopped = true;
    });
    await sleep(400);

    expect(
      state.stopped,
      "stop() returned before the approval evidence was saved",
    ).toBe(false);
    expect(
      await advisoryLocksHeldBy(appName),
      "the outlet lock was released before the approval evidence was saved",
    ).toBeGreaterThanOrEqual(1);
    const [midRow] = await ledgerRows(bill.number);
    expect(midRow?.status).not.toBe("approved");

    await vi.waitFor(() => expect(state.stopped).toBe(true), {
      timeout: 8_000,
    });
    await stopping;
    await selling.catch(() => undefined);
    const [row] = await ledgerRows(bill.number);
    expect(row?.status).toBe("approved");
    await vi.waitFor(
      async () => expect(await advisoryLocksHeldBy(appName)).toBe(0),
      { timeout: 5_000 },
    );
  });
});

describe("867 jangan sampai rugi after a heartbeat-detected lock loss", () => {
  /** The heartbeat finds the lock gone; the dead process then exits. */
  async function heartbeatLostWithLiveCall() {
    const live = await lockedAgentWithLiveCall();
    live.probe.mode = "hang";
    await vi.waitFor(
      () => {
        expect(
          fatalOf(live.agent),
          "the heartbeat never detected the dead lock connection",
        ).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    // process.exit(1) closes its sockets: the database frees the lock.
    await live.loseLock();
    return live;
  }

  it("867-M1 no second sale is sent after the heartbeat fail-stop, by the old or the new process", async () => {
    const live = await heartbeatLostWithLiveCall();
    const second = gatedProvider(new EcrSimulator("bca"), live.saleGate);
    const edc2 = newAgent(second.provider, 100);
    await edc2.start(ctx);

    await edc2
      .requestPayment(
        ctx,
        cashier.userId,
        saleRequest(live.bill, live.terminalId),
      )
      .catch(() => undefined);
    await live.agent
      .requestPayment(
        ctx,
        cashier.userId,
        saleRequest(live.bill, live.terminalId),
      )
      .catch(() => undefined);
    expect(second.state.saleCalls, "the new process sent a second sale").toBe(
      0,
    );
    expect(
      live.first.state.saleCalls,
      "the old process sent a second sale",
    ).toBe(1);

    live.saleGate.open();
    await live.selling.catch(() => undefined);
    await vi.waitFor(
      async () => {
        const rows = await ledgerRows(live.bill.number);
        expect(rows.every((r) => r.sale_wire_open_at === null)).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(live.sim.chargedCount(live.terminalId)).toBe(1);
  });

  it("867-M2 a process taking the outlet inside the late-response window keeps the wire marker; reconcile and cash stay refused", async () => {
    const live = await heartbeatLostWithLiveCall();
    expect(
      await markerOf(live.rowId),
      "the fail-stop cleared the marker of a sale that may still charge",
    ).not.toBeNull();

    const edc2 = newAgent(
      gatedProvider(new EcrSimulator("bca"), live.saleGate).provider,
      100,
    );
    await edc2.start(ctx);

    expect(
      await markerOf(live.rowId),
      "the process that took the outlet over cleared the marker inside the window",
    ).not.toBeNull();
    const byHand = await resolve(live.rowId);
    expect(
      byHand.status,
      `declined accepted while a sale call is still on the wire: ${JSON.stringify(byHand.body)}`,
    ).toBe(409);
    const cash = await pos().cash(live.bill);
    expect(
      cash.status,
      `cash accepted while a sale call is still on the wire: ${JSON.stringify(cash.body)}`,
    ).toBe(409);
  });

  it("867-M3 heartbeat finds the lock gone after the adapter answered while the evidence write runs: evidence saved, row approved, no fail-stop", async () => {
    // The late answer path (row unknown first) is where the write is
    // detached from the caller; the normal path is covered by 867-H1.
    const {
      agent: edc1,
      probe,
      bill,
      sim,
      terminalId,
      answer,
    } = await lockedAgentWithSlowApproval(
      HEARTBEAT,
      simulateExitCuttingWrites,
      true,
    );

    await answer();
    probe.mode = "hang"; // silent loss while the evidence write is running
    await sleep(HB_TIMEOUT_MS * 4);

    expect(
      fatalOf(edc1),
      "fail-stop fired for a call the terminal already answered; the evidence write would be cut",
    ).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        const [row] = await ledgerRows(bill.number);
        expect(row?.status, "approval evidence was not saved").toBe("approved");
        expect(row?.sale_wire_open_at).toBeNull();
      },
      { timeout: 8_000 },
    );
    expect(sim.chargedCount(terminalId)).toBe(1);
  });
});
