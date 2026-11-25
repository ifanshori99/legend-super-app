// 1268 B2 (legend-9yw78.2): what the cashier screens read. Payment options
// without secrets, the QR payload only while that QR may still be paid for
// exactly this bill, an honest print result, and the open-orders list.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import * as qrisHold from "../services/pos-qris-hold.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  getQris,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

const QR = "00020101021226HOLDQRIS";

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("pos-reads-b2");
});
afterEach(() => {
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

/** Owner write past the 0369 freeze triggers: the state a bug would leave. */
async function forceWrite(text: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rowCount } = await client.query(text, params);
    await client.query("COMMIT");
    expect(rowCount).toBe(1);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withoutPermission<T>(code: string, run: () => Promise<T>) {
  const change = (sql: string) =>
    owner.query(`UPDATE roles SET permissions = ${sql} WHERE id = $1`, [
      fx.tenant.roleId,
      code,
    ]);
  await change("permissions - $2::text");
  try {
    return await run();
  } finally {
    await change("permissions || to_jsonb($2::text)");
  }
}

describe("QR payload on GET .../qris", () => {
  const payloadOf = async (orderId: string) => {
    const res = await getQris(fx, orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.data).toHaveProperty("qrPayload");
    return res.body.data.qrPayload as string | null;
  };

  it("carries the payload while the hold is open, unexpired and for the whole remaining bill", async () => {
    const order = await newSubmittedOrder(fx);
    await issueQris(fx, order.id);
    expect(await payloadOf(order.id)).toBe(QR);
  });

  it("order.view alone reads the hold but never the payload", async () => {
    const order = await newSubmittedOrder(fx);
    await issueQris(fx, order.id);
    await withoutPermission("pos.payment.accept", async () => {
      const res = await getQris(fx, order.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: "open", qrPayload: null });
      expect(JSON.stringify(res.body)).not.toContain(QR);
    });
    expect(await payloadOf(order.id)).toBe(QR);
  });

  it("no payload once the cashier cancelled, also not on the cancel response", async () => {
    const order = await newSubmittedOrder(fx);
    await issueQris(fx, order.id);
    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    expect(JSON.stringify(cancelled.body)).not.toContain(QR);
    expect(await payloadOf(order.id)).toBeNull();
  });

  it("no payload once paid", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    await payNotice(fx, qr.intentId, qr.amountIdr);
    expect(await payloadOf(order.id)).toBeNull();
  });

  it("no payload while the intent is no longer pending though the hold is open", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    await forceWrite(
      "UPDATE payment_intents SET status = 'failed' WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, qr.intentId],
    );
    expect(await payloadOf(order.id)).toBeNull();
  });

  it("no payload at or after the expiry", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    const read = async (now: Date) =>
      (
        await qrisHold.getPosQrisStatus(
          fx.context,
          outletIdSchema.parse(fx.tenant.outletId),
          order.id,
          { canAcceptPayment: true },
          now,
        )
      ).qrPayload;
    expect(await read(new Date(qr.expiresAt.getTime() - 1))).toBe(QR);
    expect(await read(qr.expiresAt)).toBeNull();
  });

  it.each([
    [
      "total",
      "subtotal_idr = subtotal_idr + 1000, total_idr = total_idr + 1000",
    ],
    ["deposit", "deposit_applied_idr = 1000"],
    [
      "total and deposit together (same remaining)",
      "subtotal_idr = subtotal_idr + 1000, total_idr = total_idr + 1000, deposit_applied_idr = 1000",
    ],
  ])("no payload when the bill changed: %s", async (_label, set) => {
    const order = await newSubmittedOrder(fx);
    await issueQris(fx, order.id);
    expect(await payloadOf(order.id)).toBe(QR);
    await forceWrite(
      `UPDATE orders SET ${set} WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(await payloadOf(order.id)).toBeNull();
  });

  it("no payload of a guest QR (no POS tender)", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    await forceWrite(
      "UPDATE pos_qris_holds SET tender_id = NULL, opened_by = NULL WHERE tenant_id = $1 AND payment_intent_id = $2",
      [fx.tenant.tenantId, qr.intentId],
    );
    expect(await payloadOf(order.id)).toBeNull();
  });
});

describe("GET .../pos/payment-options", () => {
  const path = () => `/api/outlets/${fx.tenant.outletId}/pos/payment-options`;
  const insertTerminal = async (
    status: string,
    methods: string[],
    outletId = fx.tenant.outletId,
  ) => {
    const id = randomUUID();
    const tid = `TID-${randomUUID().slice(0, 8)}`;
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await client.query(
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status)
         VALUES ($1, $2, $3, 'bca', $4, 'MID-SECRET', 'Verifone X990', 'lan',
                 '10.9.8.7', $5, $6)`,
        [id, fx.tenant.tenantId, outletId, tid, methods, status],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return { id, tid };
  };
  type Method = {
    method: string;
    enabled: boolean;
    unavailableReason: unknown;
  };
  const read = async () => {
    const res = await fx.get(path());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    const data = res.body.data as {
      methods: Method[];
      edc: { ecrEnabled: boolean; terminals: Record<string, unknown>[] };
    };
    return {
      raw: JSON.stringify(res.body),
      edc: data.edc,
      of: (method: string) => data.methods.find((m) => m.method === method),
    };
  };

  it("offers EDC only with an active terminal of the method, and leaks nothing about it", async () => {
    const none = await read();
    for (const method of ["edc_card", "edc_qris"])
      expect(none.of(method)).toMatchObject({
        enabled: false,
        unavailableReason: "no_terminal",
      });
    const inactive = await insertTerminal("inactive", ["qris"]);
    const active = await insertTerminal("active", ["card"]);
    const otherOutletId = randomUUID();
    await owner.query(
      `INSERT INTO outlets
         (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B2 Lain',
              address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
      [
        otherOutletId,
        `B2-${randomUUID().slice(0, 6)}`.toUpperCase(),
        fx.tenant.outletId,
      ],
    );
    await insertTerminal("active", ["qris"], otherOutletId);
    const listed = await read();
    expect(listed.of("edc_card")).toMatchObject({ enabled: true });
    expect(listed.of("edc_qris")).toMatchObject({ enabled: false });
    expect(listed.edc.ecrEnabled).toBe(false);
    expect(listed.edc.terminals).toEqual([
      {
        id: active.id,
        bankCode: "bca",
        model: "Verifone X990",
        terminalIdLast4: active.tid.slice(-4),
        supportedMethods: ["card"],
      },
    ]);
    for (const secret of ["MID-SECRET", "10.9.8.7", active.tid, inactive.id])
      expect(listed.raw).not.toContain(secret);
  });

  it("VA, e-wallet and online card stay locked", async () => {
    const options = await read();
    for (const method of ["va", "ewallet", "card"])
      expect(options.of(method)).toEqual({
        method,
        enabled: false,
        unavailableReason: "not_supported",
      });
  });

  it("cash needs a registered device", async () => {
    expect((await read()).of("cash")).toEqual({
      method: "cash",
      enabled: false,
      unavailableReason: "device_required",
    });
    const res = await fx.staff.client
      .get(path())
      .set(fx.headers)
      .set(DEVICE_TOKEN_HEADER, fx.deviceToken);
    expect(
      (res.body.data.methods as Method[]).find((m) => m.method === "cash"),
    ).toEqual({ method: "cash", enabled: true, unavailableReason: null });
  });

  it("QRIS follows the routing rule and the gateway, failing closed", async () => {
    expect((await read()).of("qris")).toMatchObject({ enabled: true });
    setPaymentGateway(
      Object.assign(Object.create(fx.gateway), {
        health: async () => ({ status: "down" as const }),
      }),
    );
    expect((await read()).of("qris")).toMatchObject({
      enabled: false,
      unavailableReason: "gateway_down",
    });
    setPaymentGateway(
      Object.assign(Object.create(fx.gateway), {
        health: async () => {
          throw new Error("provider timeout");
        },
      }),
    );
    expect((await read()).of("qris")).toMatchObject({
      enabled: false,
      unavailableReason: "gateway_down",
    });
    setPaymentGateway(
      Object.assign(Object.create(fx.gateway), {
        methods: async () => [{ method: "qris", enabled: false, channels: [] }],
      }),
    );
    expect((await read()).of("qris")).toMatchObject({ enabled: false });
  });

  it("needs pos.payment.accept", async () => {
    await withoutPermission("pos.payment.accept", async () => {
      expect((await fx.get(path())).status).toBe(403);
    });
  });
});

describe("GET .../pos/orders for the open-orders screen", () => {
  const list = async (query: string) => {
    const res = await fx.get(`${fx.base}?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      data: {
        id: string;
        status: string;
        totalIdr: number;
        remainingIdr: number;
        tableLabel: string | null;
        heldItemCount: number;
      }[];
      meta: { totalCount: number | null; nextCursor: string | null };
    };
  };

  it("filters by table session and shows the table, the held items and what is still due", async () => {
    const guest = await fx.newGuest();
    const other = await fx.newGuest();
    const draft = await fx.createDraft(guest.sessionId);
    await fx.createDraft(other.sessionId);
    const page = await list(`tableSessionId=${guest.sessionId}`);
    expect(page.data.map((row) => row.id)).toEqual([draft.id]);
    expect(page.data[0]).toMatchObject({
      tableLabel: guest.table.code,
      heldItemCount: 1,
      remainingIdr: draft.totalIdr,
    });
    expect(page.meta.totalCount).toBeNull();
  });

  it("a takeaway has no table label", async () => {
    const created = await fx.create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const page = await list("serviceType=takeaway");
    expect(page.data[0]).toMatchObject({
      id: created.body.data.id,
      tableLabel: null,
    });
  });

  it("the remaining bill drops by the deposit and by captured money, never by an authorized QR", async () => {
    const order = await newSubmittedOrder(fx, 10_000);
    const due = order.totalIdr - 10_000;
    const row = async () =>
      (await list("limit=100")).data.find((r) => r.id === order.id);
    expect(await row()).toMatchObject({ remainingIdr: due });
    const qr = await issueQris(fx, order.id);
    expect(await row()).toMatchObject({ remainingIdr: due });
    await payNotice(fx, qr.intentId, qr.amountIdr);
    expect(await row()).toMatchObject({ remainingIdr: 0 });
  });

  it("takes several statuses and counts all matches, not only the page", async () => {
    const all = await list("limit=100");
    const expected = all.data.filter((r) =>
      ["draft", "awaiting_payment"].includes(r.status),
    );
    expect(expected.length).toBeGreaterThan(1);
    const page = await list(
      "status=draft,awaiting_payment&withCount=true&limit=1",
    );
    expect(page.data).toHaveLength(1);
    expect(page.meta.totalCount).toBe(expected.length);
    const next = await list(
      `status=draft,awaiting_payment&withCount=true&limit=100&cursor=${page.meta.nextCursor}`,
    );
    expect(next.data).toHaveLength(expected.length - 1);
    expect(next.meta.totalCount).toBe(expected.length);
    const single = await list("status=draft&limit=100");
    expect(new Set(single.data.map((r) => r.status))).toEqual(
      new Set(["draft"]),
    );
    expect((await fx.get(`${fx.base}?status=draft,nope`)).status).toBe(422);
  });
});
