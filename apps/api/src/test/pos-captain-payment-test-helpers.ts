// Real cash/QRIS boundary fixtures for the captain money regressions.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import { asCashierTenant, cashierFixture } from "./pos-cashier-test-helpers.ts";

class Gateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly requests: GatewayIntentRequest[] = [];
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.requests.push(input);
    return {
      providerRef: `CAPTAIN-${randomUUID()}`,
      instructions: {
        method: "qris" as const,
        qrPayload: "00020101021226CAPTAINMONEY",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

export async function captainPaymentFixture(label: string) {
  const fixture = await cashierFixture(label);
  const deviceId = randomUUID();
  await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query(
      "INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp) VALUES ($1,$2,1000)",
      [fixture.tenant.tenantId, fixture.tenant.outletId],
    ),
  );
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [
      fixture.tenant.roleId,
      JSON.stringify(["shift.cash.operate", "pos.discount.apply"]),
    ],
  );
  await registerTestDevice(owner, {
    tenantId: fixture.tenant.tenantId,
    outletId: fixture.tenant.outletId,
    deviceId,
  });
  setDeviceOutletResolver(async (input) =>
    input.tenantId === fixture.tenant.tenantId && input.deviceId === deviceId
      ? fixture.tenant.outletId
      : null,
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fixture.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  await openPosShift(
    context,
    { userId: userIdSchema.parse(fixture.staff.userId), deviceId },
    outletIdSchema.parse(fixture.tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const gateway = new Gateway();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  const token = signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: fixture.tenant.tenantId,
    brandId: null,
    deviceId,
  });
  const post = (path: string, body: Record<string, unknown>) =>
    fixture.staff.client
      .post(path)
      .set(fixture.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .send(body);
  const createDraft = async (sessionId: string) => {
    const result = await post(fixture.base, {
      channel: "captain",
      serviceType: "dine_in",
      tableSessionId: sessionId,
      items: [fixture.line()],
      holdItems: true,
      idempotencyKey: randomUUID(),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body.data as {
      id: string;
      status: string;
      totalIdr: number;
      depositAppliedIdr: number;
    };
  };
  const submit = (orderId: string) =>
    post(`${fixture.base}/${orderId}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
  const tender = (
    orderId: string,
    status: string,
    method: "cash" | "qris",
    receivedIdr?: number,
  ) =>
    post(`${fixture.base}/${orderId}/tenders`, {
      expectedStatus: status,
      method,
      ...(method === "cash" ? { receivedIdr } : {}),
      idempotencyKey: randomUUID(),
    });
  type Guest = { sessionId: string; token: string };
  const guestPost = (
    guest: Guest,
    path: string,
    body: Record<string, unknown>,
  ) =>
    agent(fixture.app)
      .post(`/api/table-sessions/${guest.sessionId}${path}`)
      .set(fixture.headers)
      .set(originHeader)
      .set("Authorization", `Bearer ${guest.token}`)
      .send(body);
  const qrOrder = async (guest: Guest) => {
    const added = await guestPost(guest, "/cart/lines", {
      menuItemId: fixture.ids.meal,
      modifierIds: [],
      quantity: 1,
      expectedCartVersion: 0,
      idempotencyKey: randomUUID(),
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const placed = await guestPost(guest, "/orders", {
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    return placed.body.data.order as {
      id: string;
      status: string;
      totalIdr: number;
    };
  };
  const counts = async () => {
    const { rows } = await owner.query<{
      links: number;
      intents: number;
      tenders: number;
      splits: number;
    }>(
      `SELECT
      (SELECT count(*)::int FROM payment_links WHERE tenant_id=$1) AS links,
      (SELECT count(*)::int FROM payment_intents WHERE tenant_id=$1) AS intents,
      (SELECT count(*)::int FROM pos_order_tenders WHERE tenant_id=$1) AS tenders,
      (SELECT count(*)::int FROM bill_splits WHERE tenant_id=$1) AS splits`,
      [fixture.tenant.tenantId],
    );
    return rows[0]!;
  };
  return {
    ...fixture,
    deviceToken: token,
    context,
    gateway,
    post,
    createDraft,
    submit,
    tender,
    guestPost,
    qrOrder,
    counts,
  };
}

export function resetCaptainPaymentPorts() {
  setDeviceOutletResolver(null);
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
}
export type CaptainPaymentFixture = Awaited<
  ReturnType<typeof captainPaymentFixture>
>;
