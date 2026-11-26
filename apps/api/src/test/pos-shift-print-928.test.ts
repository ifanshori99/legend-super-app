// legend-2lp.4: a successful blind close produces one edge shift report.
// The report uses the verified count and full server figures, while the
// cashier's API response remains blind. Print failures never reopen a shift.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import * as printRuntime from "../edge/print/runtime.ts";
import * as templates from "../edge/print/templates.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  createFakeClock,
  createFakeStore,
  makePrinter,
} from "./edge-print-fakes.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const roleIds = { cashier: randomUUID(), supervisor: randomUUID() };
const printerId = randomUUID();
const registeredDevices = new Map<string, string>();
const initialRuntime = getEdgeRuntimeState();
let app: Express;
let tenant: IsolatedTenant;
let supervisorId: string;

type Cashier = {
  client: ReturnType<typeof agent>;
  userId: string;
  deviceId: string;
};

async function asOwnerTenant<T>(run: (client: PoolClient) => Promise<T>) {
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

async function member(roleId: string, label: string) {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId: string = session.body.user.id;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

function shiftsPath() {
  return `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`;
}

async function openShift() {
  const cashier: Cashier = {
    ...(await member(roleIds.cashier, "Kasir Cetak Shift")),
    deviceId: randomUUID(),
  };
  registeredDevices.set(
    `${tenant.tenantId}:${cashier.deviceId}`,
    tenant.outletId,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: cashier.deviceId,
  });
  const token = signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: cashier.deviceId,
  });
  const response = await cashier.client
    .post(shiftsPath())
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, token)
    .send({ openingFloatIdr: 100_000, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const shiftId: string = response.body.data.id;
  const count = await cashier.client
    .post(`${shiftsPath()}/${shiftId}/counts`)
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      counts: [
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 20_000, quantity: 2 },
        { denominationIdr: 10_000, quantity: 1 },
      ],
    });
  expect(count.status, JSON.stringify(count.body)).toBe(201);
  const countId = posShiftCountReceiptSchema.parse(count.body.data).id;
  const approvalId = await approvalFor(cashier.userId, countId);
  const body = {
    idempotencyKey: randomUUID(),
    countId,
    approvedBy: supervisorId,
    approvalRequestId: approvalId,
  };
  return { cashier, shiftId, body };
}

async function approvalFor(requestedBy: string, countId: string) {
  const approvalId = randomUUID();
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', 0, 'pos_shift_count', $6, $7,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        approvalId,
        tenant.tenantId,
        tenant.outletId,
        requestedBy,
        supervisorId,
        countId,
        pinOverrideFixtureFingerprint({
          requestedBy: requestedBy,
          outletId: tenant.outletId,
          action: "cash_shift_close",
          valueIdr: 0,
          reason: "Hitung kas akhir shift",
          objectType: "pos_shift_count",
          objectId: countId,
          approverUserId: supervisorId,
        }),
      ],
    ),
  );
  return approvalId;
}

function closeShift(fixture: Awaited<ReturnType<typeof openShift>>) {
  return fixture.cashier.client
    .post(`${shiftsPath()}/${fixture.shiftId}/close`)
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .send(fixture.body);
}

function edgePrinter() {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );
  setEdgeRuntimeStateForTests({
    ...initialRuntime,
    edgeMode: true,
    identity: {
      context,
      scope: {
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        edgeNodeId: randomUUID(),
      },
    },
  });
  const store = createFakeStore(createFakeClock(), [
    makePrinter(printerId, {
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      paperWidth: 32,
      status: "online",
    }),
  ]);
  const printAgent = createPrintAgent({
    store,
    transportFor: () => new FakePrinterTransport(),
  });
  vi.spyOn(printRuntime, "getEdgePrintAgent").mockReturnValue(printAgent);
  return { store, printAgent };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `shift-print-${randomUUID().slice(0, 6)}`,
  );
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  for (const [id, name, permissions] of [
    [roleIds.cashier, "Kasir Cetak Shift", ["shift.cash.operate"]],
    [
      roleIds.supervisor,
      "Supervisor Cetak Shift",
      ["shift.cash.approve_close"],
    ],
  ]) {
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  }
  supervisorId = (await member(roleIds.supervisor, "Supervisor Cetak Shift"))
    .userId;
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label)
       VALUES ($1, $2, $3, 'printer', 'Printer Laporan Shift')`,
      [printerId, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO edge_printers
         (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width, status)
       VALUES ($1, $2, $3, 'Printer Laporan Shift', 'receipt', 'network', '192.168.1.50', 9100, 32, 'online')`,
      [printerId, tenant.tenantId, tenant.outletId],
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setEdgeRuntimeStateForTests(initialRuntime);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-2lp.4 shift close Print Agent integration", () => {
  it("includes committed noncash captures despite future logical fact timestamps and excludes authorized and training tenders", async () => {
    const fixture = await openShift();
    await asOwnerTenant(async (client) => {
      for (const [isTraining, status, amount, future] of [
        [false, "captured", 30_000, false],
        [false, "authorized", 40_000, false],
        [true, "captured", 50_000, false],
        // QRIS fact clocks may advance beyond this host's closing clock.
        // This capture is already committed before the shift closes.
        [false, "captured", 60_000, true],
      ] as const) {
        const orderRef = createUlid();
        const orderId = ulidToUuid(orderRef);
        // Production tender writers use an application Date. PostgreSQL's
        // VM clock can run ahead of the host that stamps the closing row.
        const requestedAt = new Date();
        const resolvedAt =
          status === "authorized"
            ? null
            : new Date(requestedAt.getTime() + (future ? 86_400_000 : 0));
        await client.query(
          `INSERT INTO orders
             (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
              subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
              status, business_date, placed_at)
           VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
                   'completed', current_date, now())`,
          [orderId, tenant.tenantId, tenant.outletId, orderRef, amount],
        );
        await client.query(
          `INSERT INTO pos_orders
             (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id, submitted_at, completed_at, is_training)
           VALUES ($1, $2, $3, 'pos', $4, $5, $6, now(), now(), $7)`,
          [
            orderId,
            tenant.tenantId,
            tenant.outletId,
            fixture.shiftId,
            fixture.cashier.deviceId,
            fixture.cashier.userId,
            isTraining,
          ],
        );
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr,
              status, requested_at, resolved_at, captured_by, shift_id)
           VALUES ($1, $2, $3, 'qris', 'manual', $4, $5::varchar,
                   $7::timestamptz, $8::timestamptz, $6, NULL)`,
          [
            tenant.tenantId,
            tenant.outletId,
            orderId,
            amount,
            status,
            fixture.cashier.userId,
            requestedAt,
            resolvedAt,
          ],
        );
      }
    });
    const { printAgent } = edgePrinter();
    const render = vi.spyOn(templates, "renderShiftReport");
    const closed = await closeShift(fixture);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const timing = await asOwnerTenant((client) =>
      client.query<{
        amount_idr: string;
        resolved_at: Date | null;
        closed_at: Date;
        delta_ms: string | null;
      }>(
        `SELECT t.amount_idr, t.resolved_at, s.closed_at,
              (extract(epoch FROM (t.resolved_at - s.closed_at)) * 1000)::text AS delta_ms
       FROM pos_order_tenders t
       JOIN pos_orders p ON p.tenant_id = t.tenant_id AND p.order_id = t.order_id
       JOIN pos_shifts s ON s.tenant_id = p.tenant_id AND s.id = p.shift_id
       WHERE t.tenant_id = $1 AND t.outlet_id = $2 AND p.shift_id = $3
       ORDER BY t.amount_idr`,
        [tenant.tenantId, tenant.outletId, fixture.shiftId],
      ),
    );
    expect(
      render,
      `Shift fixture timestamps: ${JSON.stringify(timing.rows)}`,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCash: 100_000,
        countedCash: 100_000,
        totalSales: 90_000,
        sales: [{ method: "QRIS", count: 2, amount: 90_000 }],
      }),
      32,
    );
    await printAgent.stop();
  });

  it.each([false, true])(
    "queues one report for a supervisor force-close using that supervisor's verified count (enqueue recovery: %s)",
    async (recover) => {
      const fixture = await openShift();
      const closer = await member(roleIds.supervisor, "Supervisor Tutup Paksa");
      const counted = await closer.client
        .post(`${shiftsPath()}/${fixture.shiftId}/counts`)
        .set({ Host: tenant.hostname })
        .set(originHeader)
        .send({
          idempotencyKey: randomUUID(),
          counts: [{ denominationIdr: 100_000, quantity: 1 }],
        });
      expect(counted.status, JSON.stringify(counted.body)).toBe(201);
      const countId = posShiftCountReceiptSchema.parse(counted.body.data).id;
      const request = {
        idempotencyKey: randomUUID(),
        countId,
        approvedBy: supervisorId,
        approvalRequestId: await approvalFor(closer.userId, countId),
        note: "Kasir meninggalkan outlet sebelum serah terima",
      };
      const { store, printAgent } = edgePrinter();
      const render = vi.spyOn(templates, "renderShiftReport");
      const unavailable = recover
        ? vi
            .spyOn(printAgent, "enqueue")
            .mockRejectedValueOnce(new Error("Print queue unavailable"))
        : null;
      const close = () =>
        closer.client
          .post(`${shiftsPath()}/${fixture.shiftId}/force-close`)
          .set({ Host: tenant.hostname })
          .set(originHeader)
          .send(request);
      const closed = await close();
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      if (unavailable) {
        expect(store.jobs).toHaveLength(0);
        unavailable.mockRestore();
        expect((await close()).status).toBe(200);
      }
      expect(store.jobs).toHaveLength(1);
      expect(store.jobs[0]).toMatchObject({
        kind: "shift_report",
        sourceRef: fixture.shiftId,
        createdBy: closer.userId,
      });
      expect(render).toHaveBeenCalledWith(
        expect.objectContaining({
          denominations: [
            expect.objectContaining({ count: 1, amount: 100_000 }),
          ],
        }),
        32,
      );
      expect((await close()).status).toBe(200);
      expect(store.jobs).toHaveLength(1);
      await printAgent.stop();
    },
  );

  it("renders the verified denomination count and queues one report on the receipt printer while the API stays blind", async () => {
    const fixture = await openShift();
    const { store, printAgent } = edgePrinter();
    const render = vi.spyOn(templates, "renderShiftReport");
    const closed = await closeShift(fixture);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      countedIdr: 100_000,
      expectedIdr: null,
      varianceIdr: null,
      cashSalesIdr: null,
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        openingCash: 100_000,
        expectedCash: 100_000,
        countedCash: 100_000,
        variance: 0,
        totalSales: 0,
        denominations: expect.arrayContaining([
          expect.objectContaining({ count: 1, amount: 50_000 }),
          expect.objectContaining({ count: 2, amount: 40_000 }),
          expect.objectContaining({ count: 1, amount: 10_000 }),
        ]),
      }),
      32,
    );
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      kind: "shift_report",
      printerId,
      sourceRef: fixture.shiftId,
      createdBy: fixture.cashier.userId,
    });
    expect(new TextDecoder().decode(store.jobs[0]!.content)).toContain(
      "LAPORAN TUTUP SHIFT",
    );
    const replay = await closeShift(fixture);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(store.jobs).toHaveLength(1);
    await printAgent.stop();
  });

  it("does not print a refused close", async () => {
    const fixture = await openShift();
    // A UUID naming no approval intentionally falls back to the newest
    // matching PIN override. A self-approval is unambiguously refused.
    fixture.body.approvedBy = fixture.cashier.userId;
    const { store, printAgent } = edgePrinter();
    const refused = await closeShift(fixture);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(store.jobs).toHaveLength(0);
    await printAgent.stop();
  });

  it("keeps a successful close committed on SQL queue failure and recovers one report on the authorized replay", async () => {
    const fixture = await openShift();
    const { store, printAgent } = edgePrinter();
    const enqueue = vi
      .spyOn(printAgent, "enqueue")
      .mockImplementation(async (_job, tx) => {
        if (!tx)
          throw new Error("Print job must share the closing transaction");
        // A SQL failure poisons PostgreSQL's transaction until rollback to
        // the savepoint. A JavaScript rejection alone would miss that bug.
        await tx.execute(sql`select 1 / 0`);
        throw new Error("Expected the simulated SQL failure");
      });
    const closed = await closeShift(fixture);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const { rows } = await asOwnerTenant((client) =>
      client.query<{ status: string }>(
        "SELECT status FROM pos_shifts WHERE id = $1",
        [fixture.shiftId],
      ),
    );
    expect(rows[0]?.status).toBe("closed");
    expect(store.jobs).toHaveLength(0);
    enqueue.mockRestore();
    const replay = await closeShift(fixture);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.expectedIdr).toBeNull();
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.sourceRef).toBe(fixture.shiftId);
    expect((await closeShift(fixture)).status).toBe(200);
    expect(store.jobs).toHaveLength(1);
    await printAgent.stop();
  });

  it("does not enqueue through another outlet's edge agent", async () => {
    const fixture = await openShift();
    const { store, printAgent } = edgePrinter();
    const current = getEdgeRuntimeState();
    if (!current.identity) throw new Error("Missing edge fixture identity");
    setEdgeRuntimeStateForTests({
      ...current,
      identity: {
        ...current.identity,
        scope: { ...current.identity.scope, outletId: randomUUID() },
      },
    });
    const closed = await closeShift(fixture);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(store.jobs).toHaveLength(0);
    await printAgent.stop();
  });
});

describe("P1 cloud shift report bytes (legend-wasr7.2)", () => {
  const printPath = (shiftId: string, query = "paperWidth=32") =>
    `${shiftsPath()}/${shiftId}/print?${query}`;
  const get = (client: ReturnType<typeof agent>, path: string) =>
    client.get(path).set({ Host: tenant.hostname });

  it("returns the closing report as ESC/POS bytes to a supervisor, and refuses the blind cashier and an open shift", async () => {
    const fixture = await openShift();
    const supervisor = await member(roleIds.supervisor, "Supervisor Bytes");

    const open = await get(supervisor.client, printPath(fixture.shiftId));
    expect(open.status, JSON.stringify(open.body)).toBe(409);

    const closed = await closeShift(fixture);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const blind = await get(fixture.cashier.client, printPath(fixture.shiftId));
    expect(blind.status, JSON.stringify(blind.body)).toBe(403);

    const res = await get(supervisor.client, printPath(fixture.shiftId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ paperWidth: 32, reprint: false });
    const bytes = Buffer.from(res.body.data.escposBase64, "base64");
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(bytes.toString("latin1")).toContain("LAPORAN TUTUP SHIFT");

    const bad = await get(
      supervisor.client,
      printPath(fixture.shiftId, "paperWidth=40"),
    );
    expect(bad.status).toBe(422);
  });
});
