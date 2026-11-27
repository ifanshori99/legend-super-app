// B2 (legend-wasr7.21): the EDC agent in the cloud API, driving a bridge
// tablet over WSS (cloud-runtime.ts, bridge-provider.ts, edc-bridge.routes.ts).
// Cashier HTTP -> POS route -> resolver -> cloud agent -> bridge emulator
// (src/test/helpers/edc-bridge-emulator.ts) -> answer.
//
// Mandatory checks of the brief (docs/briefs/1272-b2-brief.md):
// - a `result` counts only for a command sent to that device with the same
//   terminal/op/trace/replayOf; a late one is matched in tenant + outlet +
//   terminal only (cross-outlet and cross-tenant forgeries are dropped);
// - one EDC one tablet; no handover before issuedAt + ttl + 300 s + 30 s on the
//   cloud clock; no command with less than 30 s of lease left;
// - dispatched then disconnect / timeout = `unknown`, never `failed`;
// - no bridge = EDC_AGENT_NOT_READY and nothing written; manual EDC (X1)
//   still refused while the sale is pending/unknown;
// - revoked token: socket closed, reconnect refused, no new command;
// - device API: `payment.edc.manage` at the outlet (403), other outlet or
//   tenant = 404, pairing code (no token) shown once (no-store), token via /pair, never in audit or log,
//   revoke closes the socket; a terminal with an unfinished sale is never
//   moved, re-linked or released (EDC_TERMINAL_BUSY);
// - outlet lock lost with a sale on the wire (CTO decision): the API process
//   lives, other outlets go on, the sale ends `unknown`, new requests of that
//   outlet are refused until the lock is taken again;
// - `sale_record_release` after the settlement line matched (X2);
// - money: only a terminal `approved` with the server's amount pays.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import request from "supertest";
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
  createUlid,
  idrSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  EcrTransportError,
  EdcError,
  type EcrTerminal,
} from "@starter/shared/edc";
import {
  EDC_BRIDGE_PROTOCOL_VERSION,
  type EdcBridgeCommand,
} from "@starter/shared/edc/bridge";
import { createApp } from "../app.ts";
import { createSimulatorBridgeCodec } from "../edge/edc/bridge-codec.ts";
import {
  CloudEdcRuntime,
  EDC_BRIDGE_LEASE_TTL_MS,
  getCloudEdcRuntime,
  hashEdcBridgeToken,
  startCloudEdcRuntime,
  stopCloudEdcRuntime,
  type CloudEdcProvider,
} from "../edge/edc/cloud-runtime.ts";
import { logger } from "../lib/logger.ts";
import { attachEdcBridgeRealtime } from "../routes/edc-bridge.routes.ts";
import { owner, seedTenantOutlets } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  connectBridge,
  responseOf,
  resultFor,
  type BridgeEmulator,
  type DecodedCommand,
} from "./helpers/edc-bridge-emulator.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 60_000 });
const BILL = 33_000;
const SALE_TIMEOUT_MS = 1_500;
const GRACE_MS = 300;

let fx: HoldFixture;
let server: Server;
let realtime: { close(): Promise<void> };
let url: string;
let runtime: CloudEdcRuntime;
let offsetMs = 0;
let exit: ReturnType<typeof vi.spyOn>;
const open: BridgeEmulator[] = [];

const terminalA1 = randomUUID();
const terminalA2 = randomUUID();
const terminalB1 = randomUUID();
let outletA2: string;
let tenantB: string;
let outletB1: string;

type Device = { id: string; token: string };
let deviceA1: Device;
let deviceA1b: Device;
let deviceA2: Device;
let deviceB1: Device;

async function asTenant(tenantId: string, text: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function addTerminal(
  tenantId: string,
  outletId: string,
  id: string,
  tid: string,
) {
  await asTenant(
    tenantId,
    `INSERT INTO payment_edc_terminals
       (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
        connection, ip_address, supported_methods, status, connection_kind, link_port)
     VALUES ($1, $2, $3, 'bca', $4, 'MID-B2', 'Test EDC', 'lan', '10.0.0.8',
             ARRAY['card','qris'], 'active', 'bridge', 9100)`,
    [id, tenantId, outletId, tid],
  );
}

async function addDevice(tenantId: string, outletId: string): Promise<Device> {
  const id = createUlid();
  const token = `edcb_${id}_${randomBytes(32).toString("base64url")}`;
  await asTenant(
    tenantId,
    `INSERT INTO edc_bridge_devices (id, tenant_id, outlet_id, label, token_hash, created_by)
     VALUES ($1, $2, $3, 'Tablet', $4, 'test')`,
    [ulidToUuid(id), tenantId, outletId, hashEdcBridgeToken(token)],
  );
  return { id, token };
}

async function assign(tenantId: string, terminalId: string, device: Device) {
  await asTenant(
    tenantId,
    `UPDATE payment_edc_terminals SET bridge_device_id = $2 WHERE id = $1`,
    [terminalId, ulidToUuid(device.id)],
  );
}

async function bridge(
  device: Device | null,
  script?: (command: DecodedCommand) => ReturnType<typeof responseOf> | null,
) {
  const emulator = await connectBridge(url, device?.token ?? null, { script });
  open.push(emulator);
  return emulator;
}

const approve = (command: DecodedCommand) =>
  responseOf({
    outcome: "approved",
    amountIdr: command.body.amountIdr,
    trace: command.trace,
    approvalCode: "A1B2C3",
    rrn: `RRN${command.trace}`.slice(0, 24),
  });

const startSale = (orderId: string, key: string = randomUUID()) =>
  fx.post(`${fx.base}/${orderId}/edc`, {
    terminalId: terminalA1,
    method: "card",
    idempotencyKey: key,
  });

async function numberOf(orderId: string) {
  const res = await fx.get(`${fx.base}/${orderId}`);
  return res.body.data.number as string;
}

async function ledgerOf(reference: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: number;
    trace: string;
    dispatched: boolean;
  }>(
    `SELECT id::text AS id, status, amount_idr::int AS amount, trace,
            dispatched_at IS NOT NULL AS dispatched
       FROM edc_transactions
      WHERE tenant_id=$1 AND reference=$2 AND type='sale' ORDER BY created_at`,
    [fx.tenant.tenantId, reference],
  );
  return rows;
}

async function ecrEnabled() {
  const res = await fx.get(
    `/api/outlets/${fx.tenant.outletId}/pos/payment-options`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.edc.ecrEnabled as boolean;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backends holding the agent's advisory lock of one outlet. */
const OUTLET_LOCK = `FROM pg_locks l, LATERAL (SELECT hashtextextended($1, 0) AS h) k
  WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
    AND l.classid::bigint = ((k.h >> 32) & 4294967295)
    AND l.objid::bigint = (k.h & 4294967295)`;
const lockName = (outletId: string) =>
  `edc-agent:${fx.tenant.tenantId.toLowerCase()}:${outletId.toLowerCase()}`;

async function outletLocks(outletId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n ${OUTLET_LOCK}`,
    [lockName(outletId)],
  );
  return rows[0]!.n;
}

/** Kills the database session of the outlet's lock (a lost lock). */
async function killOutletLock(outletId: string) {
  const { rowCount } = await owner.query(
    `SELECT pg_terminate_backend(l.pid) ${OUTLET_LOCK}`,
    [lockName(outletId)],
  );
  return rowCount;
}

beforeAll(async () => {
  exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  fx = await holdFixture("edc-bridge-b2");
  const { rows } = await owner.query<{
    brand_id: string;
    legal_entity_id: string;
  }>(
    `SELECT brand_id::text, legal_entity_id::text FROM outlets WHERE id = $1`,
    [fx.tenant.outletId],
  );
  outletA2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B2 kedua', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3`,
    [outletA2, `B2${outletA2.slice(0, 6)}`.toUpperCase(), fx.tenant.outletId],
  );
  void rows;
  tenantB = randomUUID();
  [outletB1] = (await seedTenantOutlets(tenantB, 1)) as [string];
  await addTerminal(
    fx.tenant.tenantId,
    fx.tenant.outletId,
    terminalA1,
    "TID-B2-A1",
  );
  await addTerminal(fx.tenant.tenantId, outletA2, terminalA2, "TID-B2-A2");
  await addTerminal(tenantB, outletB1, terminalB1, "TID-B2-B1");
  deviceA1 = await addDevice(fx.tenant.tenantId, fx.tenant.outletId);
  deviceA1b = await addDevice(fx.tenant.tenantId, fx.tenant.outletId);
  deviceA2 = await addDevice(fx.tenant.tenantId, outletA2);
  deviceB1 = await addDevice(tenantB, outletB1);
  await assign(fx.tenant.tenantId, terminalA1, deviceA1);
  await assign(fx.tenant.tenantId, terminalA2, deviceA2);
  await assign(tenantB, terminalB1, deviceB1);

  runtime = startCloudEdcRuntime({
    codecs: [createSimulatorBridgeCodec("bca")],
    saleTimeoutMs: SALE_TIMEOUT_MS,
    traceTimeoutMs: 1_000,
    resultGraceMs: GRACE_MS,
    renewMs: 3_600_000,
    now: () => new Date(Date.now() + offsetMs),
    retryDelayMs: () => 200,
  });
  server = createServer(createApp());
  realtime = attachEdcBridgeRealtime(server, { runtime: getCloudEdcRuntime });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edc-bridge`;
});

afterEach(async () => {
  for (const emulator of open.splice(0)) emulator.close();
  await pause(50);
});

afterAll(async () => {
  await realtime?.close();
  await stopCloudEdcRuntime();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  resetHoldPorts();
  expect(exit).not.toHaveBeenCalled();
  exit.mockRestore();
  await owner.end();
});

describe("B2 bridge not connected", () => {
  it("b2-1 no bridge in this process: 503 EDC_AGENT_NOT_READY, nothing written, ECR off", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    // EDC_AGENT_NOT_READY maps to SERVICE_UNAVAILABLE "belum siap".
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(await ledgerOf(await numberOf(order.id))).toEqual([]);
    expect(await ecrEnabled()).toBe(false);
  });

  it("b2-2 no token, a malformed or unknown token: upgrade refused 401", async () => {
    expect((await bridge(null)).opened).toEqual({ ok: false, status: 401 });
    expect((await bridge({ id: "x", token: "edcb_nope" })).opened).toEqual({
      ok: false,
      status: 401,
    });
    const forged = `edcb_${createUlid()}_${randomBytes(32).toString("base64url")}`;
    expect((await bridge({ id: "x", token: forged })).opened).toEqual({
      ok: false,
      status: 401,
    });
  });
});

describe("B2 lease and sale through the bridge", () => {
  it("b2-3 hello: lease only for the device's own terminals, ttl 120 s; a terminal cannot be assigned across outlets", async () => {
    const a1 = await bridge(deviceA1);
    const lease = await a1.hello();
    expect(lease.grants.map((grant) => grant.terminalId)).toEqual([terminalA1]);
    expect(lease.grants[0]).toMatchObject({
      ttlMs: EDC_BRIDGE_LEASE_TTL_MS,
      link: { connection: "lan", host: "10.0.0.8", port: 9100 },
      framing: "stx_bcdlen_etx_lrc",
    });
    const b1 = await bridge(deviceB1);
    expect((await b1.hello()).grants.map((g) => g.terminalId)).toEqual([
      terminalB1,
    ]);
    // FK (tenant, outlet, device): an A1 terminal never goes to an A2 tablet.
    await expect(
      assign(fx.tenant.tenantId, terminalA1, deviceA2),
    ).rejects.toThrow();
  });

  it("b2-4 approved end to end; the amount sent to the terminal is the bill's, from the server", async () => {
    const seen: DecodedCommand[] = [];
    const a1 = await bridge(deviceA1, (command) => {
      seen.push(command);
      return approve(command);
    });
    await a1.hello();
    expect(await ecrEnabled()).toBe(true);
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.op).toBe("sale");
    expect(seen[0]!.body.amountIdr).toBe(BILL);
    const [row] = await ledgerOf(await numberOf(order.id));
    expect(row).toMatchObject({ status: "approved", amount: BILL });
    await pause(100);
    expect(a1.acks()).toEqual([seen[0]!.commandId]);
  });

  it("b2-5 an approved answer with another amount is never approved (unknown)", async () => {
    const a1 = await bridge(deviceA1, (command) =>
      responseOf({
        outcome: "approved",
        amountIdr: Number(command.body.amountIdr) - 1_000,
        trace: command.trace,
      }),
    );
    await a1.hello();
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.body.data.status).toBe("unknown");
  });
});

describe("B2 result matching", () => {
  it("b2-6 results from another tenant, another outlet, or with another trace/op/terminal/replayOf are dropped; the real one settles", async () => {
    let command: DecodedCommand | null = null;
    const a1 = await bridge(deviceA1, (c) => {
      command = c;
      return null;
    });
    await a1.hello();
    const b1 = await bridge(deviceB1);
    await b1.hello();
    const a2 = await bridge(deviceA2);
    await a2.hello();
    const order = await newSubmittedOrder(fx, 0);
    const sale = startSale(order.id);
    await Promise.race([
      a1.waitFor("command"),
      sale.then((res) => {
        throw new Error(`sale ended first: ${JSON.stringify(res.body)}`);
      }),
    ]);
    const c = command as unknown as DecodedCommand;
    const approved = approve(c);
    // Another tenant's tablet and another outlet's tablet replay the id.
    b1.send(resultFor(c, approved));
    a2.send(resultFor(c, approved));
    // The right tablet, but not the stored command.
    a1.send(resultFor(c, approved, { trace: "OTHERTRACE01" }));
    a1.send(resultFor(c, approved, { op: "inquiry" }));
    a1.send(resultFor(c, approved, { terminalId: terminalA2 }));
    a1.send(resultFor(c, approved, { replayOf: randomUUID() }));
    await pause(300);
    expect(b1.acks()).toEqual([]);
    expect(a2.acks()).toEqual([]);
    expect(a1.acks()).toEqual([]);
    expect((await ledgerOf(await numberOf(order.id)))[0]!.status).toBe(
      "pending",
    );
    a1.send(resultFor(c, approved));
    const res = await sale;
    expect(res.body.data.status).toBe("approved");
    await pause(100);
    expect(a1.acks()).toEqual([c.commandId]);
  });

  it("b2-7 timeout after dispatch = unknown (never failed); the late result is stored and acked only for its own device; the row stays unknown", async () => {
    let command: DecodedCommand | null = null;
    const a1 = await bridge(deviceA1, (c) => {
      command = c;
      return null;
    });
    await a1.hello();
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.body.data.status).toBe("unknown");
    await pause(SALE_TIMEOUT_MS + GRACE_MS);
    const c = command as unknown as DecodedCommand;
    const [row] = await ledgerOf(await numberOf(order.id));
    expect(row).toMatchObject({ status: "unknown", dispatched: true });
    // Same tenant, other outlet (A2): neither the command's terminal nor
    // its own terminal makes the late result count (review P3-6).
    const a2 = await bridge(deviceA2);
    await a2.hello();
    a2.send(resultFor(c, approve(c)));
    a2.send(resultFor(c, approve(c), { terminalId: terminalA2 }));
    await pause(300);
    expect(a2.acks()).toEqual([]);
    const untouched = await owner.query(
      `SELECT result_outcome FROM edc_bridge_commands WHERE id = $1`,
      [c.commandId],
    );
    expect(untouched.rows).toEqual([{ result_outcome: null }]);
    const b1 = await bridge(deviceB1);
    await b1.hello();
    b1.send(resultFor(c, approve(c)));
    a1.send(resultFor(c, approve(c)));
    await pause(300);
    expect(b1.acks()).toEqual([]);
    expect(a1.acks()).toEqual([c.commandId]);
    const { rows } = await owner.query(
      `SELECT result_outcome FROM edc_bridge_commands WHERE id = $1`,
      [c.commandId],
    );
    expect(rows).toEqual([{ result_outcome: "response" }]);
    expect((await ledgerOf(await numberOf(order.id)))[0]!.status).toBe(
      "unknown",
    );
  });

  it("b2-8 socket lost after dispatch = unknown, never failed; manual EDC (X1) refused while it is open", async () => {
    const a1 = await bridge(deviceA1, () => {
      a1.close();
      return null;
    });
    await a1.hello();
    const order = await newSubmittedOrder(fx, 0);
    const res = await startSale(order.id);
    expect(res.body.data.status).toBe("unknown");
    await pause(SALE_TIMEOUT_MS + GRACE_MS);
    const [row] = await ledgerOf(await numberOf(order.id));
    expect(row).toMatchObject({ status: "unknown", dispatched: true });
    const bill = await fx.get(`${fx.base}/${order.id}`);
    const manual = await fx.post(`${fx.base}/${order.id}/tenders`, {
      expectedStatus: bill.body.data.status,
      method: "edc_card",
      standalone: { terminalId: terminalA1, bankRef: "SLIPB2X1" },
      idempotencyKey: randomUUID(),
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(409);
    // No bridge now: ECR locked again.
    expect(await ecrEnabled()).toBe(false);
  });
});

describe("B2 lease on the cloud clock", () => {
  it("b2-9 no command with < 30 s of lease left; another tablet waits until issuedAt + ttl + 300 s + 30 s", async () => {
    const a1 = await bridge(deviceA1, approve);
    await a1.hello();
    offsetMs += EDC_BRIDGE_LEASE_TTL_MS - 29_000;
    try {
      const order = await newSubmittedOrder(fx, 0);
      const res = await startSale(order.id);
      expect(res.status).toBe(503);
      expect(await ledgerOf(await numberOf(order.id))).toEqual([]);
      expect(a1.received.some((m) => m.type === "command")).toBe(false);

      // Move the terminal to the second tablet of the outlet.
      await assign(fx.tenant.tenantId, terminalA1, deviceA1b);
      const a1b = await bridge(deviceA1b, approve);
      const lease = await a1b.hello();
      expect(lease.grants).toEqual([]);
      expect(lease.refused).toEqual([
        { terminalId: terminalA1, reason: "held_by_other_device" },
      ]);
      // issuedAt was 91 s ago: reusable at +450 s, i.e. 359 s from now.
      offsetMs += 358_000;
      let from = a1b.received.length;
      await runtime.renewAll();
      expect((await a1b.waitFor("lease", from)).grants).toEqual([]);
      offsetMs += 2_000;
      from = a1b.received.length;
      await runtime.renewAll();
      const handed = await a1b.waitFor("lease", from);
      expect(handed.grants.map((g) => g.terminalId)).toEqual([terminalA1]);
      // The old tablet no longer gets the terminal.
      const old = a1.received.filter((m) => m.type === "lease").at(-1);
      expect(old && old.type === "lease" ? old.grants : null).toEqual([]);
      const order2 = await newSubmittedOrder(fx, 0);
      const sale = await startSale(order2.id);
      expect(sale.body.data.status).toBe("approved");
      expect(a1.received.some((m) => m.type === "command")).toBe(false);
    } finally {
      await assign(fx.tenant.tenantId, terminalA1, deviceA1);
      offsetMs += 500_000;
      await runtime.renewAll();
    }
  });
});

describe("B2 outlet lock lost", () => {
  it("b2-12 lock lost with a sale on the wire: the API lives, the other outlet goes on, the sale ends unknown, new requests refused until the lock is back", async () => {
    const a2 = await bridge(deviceA2, approve);
    await a2.hello();
    const a1 = await bridge(deviceA1, () => null);
    await a1.hello();
    expect(await outletLocks(fx.tenant.outletId)).toBe(1);
    expect(await outletLocks(outletA2)).toBe(1);
    const from = a1.received.length;
    const order = await newSubmittedOrder(fx, 0);
    const sale = startSale(order.id);
    const saleCommand = () =>
      a1.received
        .slice(from)
        .find((m) => m.type === "command" && m.op === "sale");
    await Promise.race([
      vi.waitFor(
        () =>
          expect(
            saleCommand(),
            JSON.stringify(a1.received.slice(from).map((m) => m.type)),
          ).toBeDefined(),
        { timeout: 10_000 },
      ),
      sale.then((res) => {
        throw new Error(`sale ended first: ${JSON.stringify(res.body)}`);
      }),
    ]);
    const command = saleCommand() as Extract<
      (typeof a1.received)[number],
      { type: "command" }
    >;

    expect(await killOutletLock(fx.tenant.outletId)).toBe(1);
    // Only that outlet's bridge is told and closed.
    expect(await a1.waitFor("goodbye", from)).toEqual({
      type: "goodbye",
      reason: "server_shutdown",
    });
    expect(await a1.closed()).not.toBeNull();
    expect(runtime.agentFor(fx.tenant.tenantId, fx.tenant.outletId)).toBeNull();
    // A new request of the outlet: refused, nothing written.
    const second = await newSubmittedOrder(fx, 0);
    const refused = await startSale(second.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(refused.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(await ledgerOf(await numberOf(second.id))).toEqual([]);

    // The tablet comes back and reports an approval for the old command:
    // stored and acked, but the ledger is not settled by it.
    const back = await bridge(deviceA1, () => null);
    await back.hello();
    const acked = back.received.length;
    back.send(
      resultFor(
        command,
        responseOf({
          outcome: "approved",
          amountIdr: BILL,
          trace: command.trace,
          approvalCode: "A1B2C3",
          rrn: `RRN${command.trace}`.slice(0, 24),
        }),
      ),
    );
    expect(await back.waitFor("ack", acked)).toEqual({
      type: "ack",
      commandId: command.commandId,
    });
    expect((await sale).body.data.status).toBe("unknown");
    await pause(SALE_TIMEOUT_MS + GRACE_MS);
    const [row] = await ledgerOf(await numberOf(order.id));
    expect(row).toMatchObject({ status: "unknown", dispatched: true });

    // The other outlet kept its lock, agent and bridge; the process lives.
    expect(a2.closeCode).toBeNull();
    expect(await outletLocks(outletA2)).toBe(1);
    expect(runtime.agentFor(fx.tenant.tenantId, outletA2)).not.toBeNull();
    expect(exit).not.toHaveBeenCalled();

    // Retried with backoff: the lock is taken again and the lease comes back.
    await vi.waitFor(
      () =>
        expect(
          runtime.agentFor(fx.tenant.tenantId, fx.tenant.outletId),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(await outletLocks(fx.tenant.outletId)).toBe(1);
    const renewed = back.received.length;
    await runtime.renewAll();
    expect(
      (await back.waitFor("lease", renewed)).grants.map((g) => g.terminalId),
    ).toEqual([terminalA1]);
  });
});

describe("B2 device API", () => {
  const DEVICES = "/api/edc-bridge/devices";
  let managerA1: ReturnType<typeof agent>;
  const as = (client: ReturnType<typeof agent>) => ({
    get: (path: string) => client.get(path).set(fx.headers).set(originHeader),
    post: (path: string, body: Record<string, unknown>) =>
      client.post(path).set(fx.headers).set(originHeader).send(body),
    put: (path: string, body: Record<string, unknown>) =>
      client.put(path).set(fx.headers).set(originHeader).send(body),
  });

  beforeAll(async () => {
    await owner.query(
      "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
      [fx.tenant.roleId, JSON.stringify(["payment.edc.manage"])],
    );
    // A manager of outlet A1 only.
    managerA1 = agent(fx.app);
    await signUp(managerA1, "B2 Manager A1");
    const session = await managerA1.get("/api/auth/get-session");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [
        fx.tenant.tenantId,
        session.body.user.id,
        fx.tenant.roleId,
        fx.tenant.outletId,
      ],
    );
  });

  it("b2-13 a terminal with an unfinished sale is not moved, re-linked or released (EDC_TERMINAL_BUSY); a free one is", async () => {
    const api = as(fx.staff.client);
    await asTenant(
      fx.tenant.tenantId,
      `INSERT INTO edc_transactions
         (tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, trace)
       VALUES ($1, $2, $3, 'bca', $4, $5, 'fp', 25000, 'card', 'unknown', $6)`,
      [
        fx.tenant.tenantId,
        outletA2,
        terminalA2,
        `B2BUSY${randomUUID().slice(0, 8)}`,
        randomUUID(),
        `T${Date.now()}`.slice(0, 12),
      ],
    );
    const spare = await addDevice(fx.tenant.tenantId, outletA2);
    const busy = [
      // Move to another tablet.
      await api.put(`${DEVICES}/${spare.id}/terminals`, {
        terminals: [
          { terminalId: terminalA2, linkPort: 9100, linkBaudRate: null },
        ],
      }),
      // Same tablet, another port.
      await api.put(`${DEVICES}/${deviceA2.id}/terminals`, {
        terminals: [
          { terminalId: terminalA2, linkPort: 9200, linkBaudRate: null },
        ],
      }),
      // Released.
      await api.put(`${DEVICES}/${deviceA2.id}/terminals`, { terminals: [] }),
    ];
    for (const res of busy) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.message).toMatch(/^EDC_TERMINAL_BUSY: /);
    }
    const { rows } = await owner.query<{ device: string; port: number }>(
      `SELECT bridge_device_id::text AS device, link_port AS port
         FROM payment_edc_terminals WHERE id = $1`,
      [terminalA2],
    );
    expect(rows[0]).toEqual({ device: ulidToUuid(deviceA2.id), port: 9100 });
    // Unchanged assignment of a busy terminal: allowed.
    const same = await api.put(`${DEVICES}/${deviceA2.id}/terminals`, {
      terminals: [
        { terminalId: terminalA2, linkPort: 9100, linkBaudRate: null },
      ],
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    // A terminal with no open sale moves freely.
    const free = randomUUID();
    await addTerminal(fx.tenant.tenantId, outletA2, free, "TID-B2-FREE");
    const moved = await api.put(`${DEVICES}/${spare.id}/terminals`, {
      terminals: [{ terminalId: free, linkPort: 9300, linkBaudRate: null }],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.terminalIds).toEqual([free]);
  });

  it("b2-14 permission per outlet, 404 across outlet and tenant, token once and never logged, revoke closes the socket", async () => {
    const manager = as(managerA1);
    // No payment.edc.manage at outlet A2: 403 on list and issue.
    expect((await manager.get(`${DEVICES}?outletId=${outletA2}`)).status).toBe(
      403,
    );
    expect(
      (await manager.post(DEVICES, { outletId: outletA2, label: "X" })).status,
    ).toBe(403);
    // A device of outlet A2 or of tenant B: 404, not 403.
    for (const device of [deviceA2, deviceB1]) {
      const revoke = await manager.post(`${DEVICES}/${device.id}/revoke`, {});
      expect(revoke.status, JSON.stringify(revoke.body)).toBe(404);
      const put = await manager.put(`${DEVICES}/${device.id}/terminals`, {
        terminals: [],
      });
      expect(put.status, JSON.stringify(put.body)).toBe(404);
    }
    expect(
      (await as(fx.staff.client).get(`${DEVICES}?outletId=${outletB1}`)).status,
    ).not.toBe(200);

    // Issue on outlet A1: token in this answer only, never cached or logged.
    const spies = (
      ["trace", "debug", "info", "warn", "error", "fatal"] as const
    ).map((level) => vi.spyOn(logger, level));
    let token: string;
    let issuedId: string;
    try {
      const issued = await manager.post(DEVICES, {
        outletId: fx.tenant.outletId,
        label: "Tablet kasir",
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      issuedId = issued.body.data.device.id as string;
      // B4: the answer carries a pairing code, the tablet trades it.
      expect(issued.body.data).not.toHaveProperty("token");
      const paired = await request(fx.app)
        .post("/api/edc-bridge/pair")
        .send({ code: issued.body.data.pairCode.code });
      expect(paired.status, JSON.stringify(paired.body)).toBe(200);
      token = paired.body.data.token as string;
      expect(token.startsWith(`edcb_${issuedId}_`)).toBe(true);
      const list = await manager.get(
        `${DEVICES}?outletId=${fx.tenant.outletId}`,
      );
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(token);
      const tablet = await bridge({ id: issuedId, token });
      expect(tablet.opened).toEqual({ ok: true });
      await tablet.hello();
      // Revoke through the route: goodbye, socket closed, token refused.
      const revoked = await manager.post(`${DEVICES}/${issuedId}/revoke`, {});
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(await tablet.waitFor("goodbye")).toEqual({
        type: "goodbye",
        reason: "token_revoked",
      });
      expect(await tablet.closed()).not.toBeNull();
      expect((await bridge({ id: issuedId, token })).opened).toEqual({
        ok: false,
        status: 401,
      });
      for (const spy of spies)
        expect(inspect(spy.mock.calls, { depth: 8 })).not.toContain(token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const audit = await owner.query<{ row: string }>(
      `SELECT row_to_json(a)::text AS row FROM audit_logs a
        WHERE tenant_id = $1 AND event->>'objectType' = 'edc_bridge_device' AND event->>'objectId' = $2`,
      [fx.tenant.tenantId, issuedId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    for (const { row } of audit.rows) {
      expect(row).not.toContain(token);
      expect(row).not.toContain(hashEdcBridgeToken(token));
    }
  });
});

describe("B2 cloud provider slot (bca_cloud, B5a)", () => {
  async function addOutlet(code: string) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B2 cloud', 'Jl. Uji 3', timezone, opening_hours, 'active'
         FROM outlets WHERE id = $3`,
      [id, `${code}${id.slice(0, 6)}`.toUpperCase(), fx.tenant.outletId],
    );
    return id;
  }

  it("b2-15 outlets of a cloud provider are taken at boot and lazily (idempotent); readiness is the provider's", async () => {
    const outletC = await addOutlet("C");
    const outletD = await addOutlet("D");
    const terminalC = randomUUID();
    const addCloudTerminal = (id: string, outletId: string, tid: string) =>
      asTenant(
        fx.tenant.tenantId,
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status, connection_kind)
         VALUES ($1, $2, $3, 'bca', $4, 'MID-B2', 'BCA cloud', 'lan', '10.0.0.9',
                 ARRAY['card','qris'], 'active', 'bca_cloud')`,
        [id, fx.tenant.tenantId, outletId, tid],
      );
    await addCloudTerminal(terminalC, outletC, "TID-B2-C1");
    // B5a: only an outlet with an active bca_cloud terminal is taken lazily.
    await addCloudTerminal(randomUUID(), outletD, "TID-B2-D1");
    let ready = true;
    const unused = () => Promise.reject(new Error("not called"));
    const fake: CloudEdcProvider = {
      bank: "bca",
      capabilities: { inquiry: "by_trace", cancelInProgress: false },
      sale: unused,
      cancel: unused,
      inquiry: unused,
      void: unused,
      ready: () => ready,
      outlets: async () => [
        { tenantId: fx.tenant.tenantId, outletId: outletC },
      ],
    };
    const cloud = new CloudEdcRuntime({
      bcaCloud: fake,
      codecs: [],
      renewMs: 3_600_000,
      retryDelayMs: () => 200,
    });
    try {
      expect(cloud.agentFor(fx.tenant.tenantId, outletC)).toBeNull();
      await cloud.startOutlets();
      expect(cloud.agentFor(fx.tenant.tenantId, outletC)).not.toBeNull();
      expect(await outletLocks(outletC)).toBe(1);
      // Idempotent: no second lock.
      expect(await cloud.ensureOutlet(fx.tenant.tenantId, outletC)).toBe(true);
      expect(await outletLocks(outletC)).toBe(1);
      const target = {
        id: terminalC,
        tenantId: fx.tenant.tenantId,
        outletId: outletC,
        connectionKind: "bca_cloud",
      };
      expect(cloud.registry.get("bca", target)).toBe(fake);
      ready = false;
      expect(() => cloud.registry.get("bca", target)).toThrow(
        new EdcError("EDC_AGENT_NOT_READY"),
      );
      // An outlet added after boot: taken on its first sale.
      expect(cloud.agentFor(fx.tenant.tenantId, outletD)).toBeNull();
      await cloud.prepareSale(fx.tenant.tenantId, outletD);
      expect(cloud.agentFor(fx.tenant.tenantId, outletD)).not.toBeNull();
      // The shared runtime (no cloud provider) never takes outlets lazily.
      await runtime.prepareSale(fx.tenant.tenantId, outletD);
      expect(runtime.agentFor(fx.tenant.tenantId, outletD)).toBeNull();
    } finally {
      await cloud.stop();
    }
    expect(await outletLocks(outletC)).toBe(0);
    expect(await outletLocks(outletD)).toBe(0);
  });
});

describe("B2 runtime writes (review P3)", () => {
  let outletE: string;
  const terminalE = randomUUID();
  let deviceE: Device;
  let cloud: CloudEdcRuntime;
  let boom = false;

  beforeAll(async () => {
    outletE = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B2 E', 'Jl. Uji 4', timezone, opening_hours, 'active'
         FROM outlets WHERE id = $3`,
      [outletE, `E${outletE.slice(0, 6)}`.toUpperCase(), fx.tenant.outletId],
    );
    await addTerminal(fx.tenant.tenantId, outletE, terminalE, "TID-B2-E1");
    deviceE = await addDevice(fx.tenant.tenantId, outletE);
    await assign(fx.tenant.tenantId, terminalE, deviceE);
    cloud = new CloudEdcRuntime({
      codecs: [createSimulatorBridgeCodec("bca")],
      saleTimeoutMs: 1_000,
      traceTimeoutMs: 1_000,
      resultGraceMs: 200,
      renewMs: 3_600_000,
      now: () => {
        if (boom) {
          boom = false;
          throw new Error("clock failed");
        }
        return new Date();
      },
    });
  });

  afterAll(async () => {
    await cloud?.stop();
  });

  type Sent = { type: string } & Record<string, unknown>;
  /** A tablet session on `cloud` over a fake socket. */
  function tablet(onCommand?: (command: EdcBridgeCommand) => void) {
    const sent: Sent[] = [];
    const handlers = cloud.open(
      {
        id: deviceE.id,
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        outletId: outletIdSchema.parse(outletE),
      },
      {
        send: (text) => {
          const message = JSON.parse(text) as Sent;
          sent.push(message);
          if (message.type === "command")
            onCommand?.(message as unknown as EdcBridgeCommand);
          return true;
        },
        close: () => undefined,
      },
    );
    const hello = () =>
      handlers.message({
        type: "hello",
        protocolVersion: EDC_BRIDGE_PROTOCOL_VERSION,
        appVersion: "0.1.0",
        unackedResults: 0,
        heldSaleRecords: 0,
      });
    return { sent, handlers, hello };
  }

  const terminal = (): EcrTerminal => ({
    tenantId: fx.tenant.tenantId,
    outletId: outletE,
    id: terminalE,
    bank: "bca",
    terminalId: "TID-B2-E1",
    merchantId: "MID-B2",
    connection: "lan",
    ipAddress: "10.0.0.8",
  });
  const trace = () => `B2${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const sale = (value: string) =>
    cloud.registry.bridgeProvider("bca")!.sale({
      terminal: terminal(),
      trace: value,
      amountIdr: idrSchema.parse(BILL),
      method: "card",
      reference: "B2-REF",
      signal: new AbortController().signal,
    });
  const approval = (command: Pick<EdcBridgeCommand, "trace">) =>
    responseOf({
      outcome: "approved",
      amountIdr: BILL,
      trace: command.trace,
      approvalCode: "AP1234",
      rrn: "RRNB2E1",
      maskedPan: "411111******1111",
      message: "APPROVED",
    });
  const acksOf = (sent: Sent[]) =>
    sent.filter((m) => m.type === "ack").map((m) => m.commandId);

  /** Makes the next `n` inserts into edc_bridge_commands fail. */
  async function failCommandInserts(n: number) {
    // A sequence, not a table: a failed insert rolls back table writes.
    await owner.query(
      `DROP SEQUENCE IF EXISTS b2_fail_seq;
       CREATE SEQUENCE b2_fail_seq;
       CREATE OR REPLACE FUNCTION b2_fail_insert() RETURNS trigger
         LANGUAGE plpgsql SECURITY DEFINER AS $$
       BEGIN
         IF nextval('b2_fail_seq') <= ${n} THEN
           RAISE EXCEPTION 'b2 insert refused';
         END IF;
         RETURN NEW;
       END $$;
       DROP TRIGGER IF EXISTS b2_fail_insert ON edc_bridge_commands;
       CREATE TRIGGER b2_fail_insert BEFORE INSERT ON edc_bridge_commands
         FOR EACH ROW EXECUTE FUNCTION b2_fail_insert();`,
    );
  }
  async function stopFailing() {
    await owner.query(
      `DROP TRIGGER IF EXISTS b2_fail_insert ON edc_bridge_commands;
       DROP FUNCTION IF EXISTS b2_fail_insert();
       DROP SEQUENCE IF EXISTS b2_fail_seq;`,
    );
  }

  it("b2-16 an error after the command is on the socket never makes it 'not sent': the sale ends as a transport error (unknown)", async () => {
    const t = tablet(() => {
      // The clock fails right after the socket write.
      boom = true;
    });
    await t.hello();
    await expect(sale(trace())).rejects.toBeInstanceOf(EcrTransportError);
    expect(t.sent.some((m) => m.type === "command")).toBe(true);
  });

  it("b2-17 overlapping renewals of one session hand out one lease id, the one in the database", async () => {
    const t = tablet();
    // Hold the lease row so the three renewals are all in flight at once.
    const hold = await owner.connect();
    let renewals: Promise<unknown>;
    try {
      await hold.query("BEGIN");
      await hold.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      const { rowCount } = await hold.query(
        "SELECT 1 FROM edc_bridge_terminal_leases WHERE terminal_id = $1 FOR UPDATE",
        [terminalE],
      );
      expect(rowCount).toBe(1);
      renewals = Promise.all([t.hello(), cloud.renewAll(), cloud.renewAll()]);
      await pause(300);
    } finally {
      await hold.query("COMMIT");
      hold.release();
    }
    await renewals;
    const ids = t.sent
      .filter((m) => m.type === "lease")
      .flatMap((m) =>
        (m.grants as Array<{ terminalId: string; leaseId: string }>)
          .filter((g) => g.terminalId === terminalE)
          .map((g) => g.leaseId),
      );
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
    const { rows } = await owner.query<{ lease: string }>(
      "SELECT lease_id::text AS lease FROM edc_bridge_terminal_leases WHERE terminal_id = $1",
      [terminalE],
    );
    expect(rows[0]!.lease).toBe(ids[0]);
  });

  it("b2-18 the command row is retried; ack only once stored; still failing = no ack and an ops alert", async () => {
    try {
      // Two failed inserts, then it goes in: acked.
      await failCommandInserts(2);
      const t = tablet((command) => {
        void t.handlers.message(resultFor(command, approval(command)));
      });
      await t.hello();
      const first = await sale(trace());
      expect(first.outcome).toBe("approved");
      await vi.waitFor(() => expect(acksOf(t.sent)).toHaveLength(1), {
        timeout: 5_000,
      });
      // Never stored: the answer still settles the sale in memory, no ack.
      await failCommandInserts(100);
      const errors = vi.spyOn(logger, "error");
      try {
        const second = await sale(trace());
        expect(second.outcome).toBe("approved");
        await vi.waitFor(
          () =>
            expect(
              errors.mock.calls.some(
                ([meta]) =>
                  (meta as { alert?: string } | undefined)?.alert ===
                  "edc_cloud_result_persist_failed",
              ),
            ).toBe(true),
          { timeout: 10_000 },
        );
        expect(acksOf(t.sent)).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    } finally {
      await stopFailing();
    }
  });

  it("b2-19 a late result keeps its approval code and RRN, without PAN or terminal text", async () => {
    let command: EdcBridgeCommand | undefined;
    const t = tablet((sent) => {
      command = sent;
    });
    await t.hello();
    await expect(sale(trace())).rejects.toBeInstanceOf(EcrTransportError);
    await t.handlers.message(resultFor(command!, approval(command!)));
    expect(acksOf(t.sent)).toEqual([command!.commandId]);
    const { rows } = await owner.query<{ evidence: Record<string, unknown> }>(
      "SELECT result_evidence AS evidence FROM edc_bridge_commands WHERE id = $1",
      [command!.commandId],
    );
    expect(rows[0]!.evidence).toMatchObject({
      outcome: "approved",
      amountIdr: BILL,
      approvalCode: "AP1234",
      rrn: "RRNB2E1",
      trace: command!.trace,
    });
    const text = JSON.stringify(rows[0]!.evidence);
    expect(text).not.toContain("411111");
    expect(text).not.toContain("APPROVED");
  });
});

describe("B2 revocation and release", () => {
  it("b2-10 sale_record_release for the traces whose settlement matched, again on hello until sent", async () => {
    const a1 = await bridge(deviceA1, approve);
    await a1.hello();
    const order = await newSubmittedOrder(fx, 0);
    expect((await startSale(order.id)).body.data.status).toBe("approved");
    const [row] = await ledgerOf(await numberOf(order.id));
    const fileId = randomUUID();
    await asTenant(
      fx.tenant.tenantId,
      `INSERT INTO edc_settlement_files (id, tenant_id, outlet_id, bank, file_name, file_hash,
          row_count, matched_count, cleared_count, mismatch_count, unmatched_count, duplicate_count, imported_by)
       VALUES ($1, $2, $3, 'bca', 'b2.csv', $4, 1, 1, 0, 0, 0, 0, 'test')`,
      [
        fileId,
        fx.tenant.tenantId,
        fx.tenant.outletId,
        randomBytes(32).toString("hex"),
      ],
    );
    await asTenant(
      fx.tenant.tenantId,
      `INSERT INTO edc_settlement_rows (tenant_id, outlet_id, file_id, line_no, row_key, bank,
          terminal_code, terminal_id, rrn, amount_idr, match_status, matched_edc_transaction_id)
       VALUES ($1, $2, $3, 1, $4, 'bca', 'TID-B2-A1', $5, 'RRNB2', $6, 'matched', $7)`,
      [
        fx.tenant.tenantId,
        fx.tenant.outletId,
        fileId,
        randomBytes(16).toString("hex"),
        terminalA1,
        BILL,
        row!.id,
      ],
    );
    a1.close();
    await pause(200);
    // Offline at match time: sent on the next hello.
    await runtime.settlementMatched(fx.tenant.tenantId, fx.tenant.outletId);
    const again = await bridge(deviceA1, approve);
    await again.hello();
    const release = await again.waitFor("sale_record_release");
    expect(release).toEqual({
      type: "sale_record_release",
      terminalId: terminalA1,
      traces: [row!.trace],
    });
  });

  it("b2-11 revoked token: goodbye token_revoked, socket closed, reconnect refused, ECR locked", async () => {
    const a1 = await bridge(deviceA1, approve);
    await a1.hello();
    await asTenant(
      fx.tenant.tenantId,
      `UPDATE edc_bridge_devices SET revoked_at = now() WHERE id = $1`,
      [ulidToUuid(deviceA1.id)],
    );
    runtime.revoked(fx.tenant.tenantId, deviceA1.id);
    expect(await a1.waitFor("goodbye")).toEqual({
      type: "goodbye",
      reason: "token_revoked",
    });
    expect(await a1.closed()).not.toBeNull();
    expect((await bridge(deviceA1)).opened).toEqual({ ok: false, status: 401 });
    const order = await newSubmittedOrder(fx, 0);
    expect((await startSale(order.id)).status).toBe(503);
    expect(await ledgerOf(await numberOf(order.id))).toEqual([]);
  });
});
