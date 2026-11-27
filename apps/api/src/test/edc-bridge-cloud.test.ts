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
// - outlet lock lost with a sale on the wire (CTO decision): the API process
//   lives, other outlets go on, the sale ends `unknown`, new requests of that
//   outlet are refused until the lock is taken again;
// - `sale_record_release` after the settlement line matched (X2);
// - money: only a terminal `approved` with the server's amount pays.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { createSimulatorBridgeCodec } from "../edge/edc/bridge-codec.ts";
import {
  EDC_BRIDGE_LEASE_TTL_MS,
  getCloudEdcRuntime,
  hashEdcBridgeToken,
  startCloudEdcRuntime,
  stopCloudEdcRuntime,
  type CloudEdcRuntime,
} from "../edge/edc/cloud-runtime.ts";
import { attachEdcBridgeRealtime } from "../routes/edc-bridge.routes.ts";
import { owner, seedTenantOutlets } from "./floor-test-helpers.ts";
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
