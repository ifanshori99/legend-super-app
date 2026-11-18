// legend-nqfov (P2 finding of the 1004 review): replaying an e-wallet / card
// guest payment must not depend on the method being available right now.
//
// Written from docs/CONTRACT.md-level behavior, the legend-gp3fw replay rule
// (same key + same payload = the stored answer; same key + other payload =
// 409 IDEMPOTENCY_KEY_REUSED) and the kt3t1 tests, not from the implementation.
//
// Scenario: the guest got a pending e-wallet / card intent but the POST answer
// was lost. Before the retry the gateway's methods() fails, or the tenant's
// routing for the method is switched off. The retry with the same key and the
// same payload must still return the same pending intent (id + redirect URL):
// one provider create, no void, no new intent.
//
// Assumptions (also in the report)
// - "methods() fails" = the double throws from methods() and channels().
// - A same-key retry of a payload that differs (other channel / other method)
//   is 409 IDEMPOTENCY_KEY_REUSED even while the method is unavailable.
// - A NEW key while the method is disabled is 400 (the brief: "still rejected
//   400"), no provider request, no intent.
// - A replay of a closed code (voided by a swap, or expired) never exposes the
//   pay link: refused (4xx) or 2xx with redirectUrl null, pay URL nowhere in the
//   body; never 5xx, never a new intent or provider create.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1004-nqfov-ewallet-card-replay.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PaymentInstructions } from "@starter/shared/payment";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { intentCount, intentRow } from "./qr-va-912-3p1-helpers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Offered = {
  method: GatewayPaymentMethod;
  enabled: boolean;
  channels: { code: string; name: string }[];
};

const ALL_ON = (): Offered[] => [
  { method: "qris", enabled: true, channels: [] },
  {
    method: "va",
    enabled: true,
    channels: [
      { code: "BC", name: "BCA Virtual Account" },
      { code: "I1", name: "BNI Virtual Account" },
    ],
  },
  {
    method: "ewallet",
    enabled: true,
    channels: [
      { code: "OV", name: "OVO" },
      { code: "DA", name: "DANA" },
    ],
  },
  {
    method: "card",
    enabled: true,
    channels: [{ code: "VC", name: "Credit Card" }],
  },
];

/** Duitku-like double whose methods() can be made to fail. */
class FlakyGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  offered: Offered[] = ALL_ON();
  failMethods = false;
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  private sequence = 0;
  reset() {
    this.offered = ALL_ON();
    this.failMethods = false;
    this.created.length = 0;
  }
  setEnabled(method: GatewayPaymentMethod, enabled: boolean) {
    this.offered = this.offered.map((entry) =>
      entry.method === method ? { ...entry, enabled } : entry,
    );
  }
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    if (this.failMethods) throw new Error("gateway methods() unavailable");
    return this.offered;
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    if (this.failMethods) throw new Error("gateway channels() unavailable");
    const entry = this.offered.find(
      (candidate) => candidate.method === method && candidate.enabled,
    );
    return entry ? entry.channels : [];
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `NQF-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const channels =
      this.offered.find((entry) => entry.method === input.method)?.channels ??
      [];
    const channel = channels.find((c) => c.code === input.channelCode);
    let instructions: unknown;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: input.channelCode ?? "BC",
        channelName: channel?.name ?? "BCA Virtual Account",
        virtualAccountNumber: `8809${n}`,
      };
    else if (input.method === "ewallet" || input.method === "card")
      instructions = {
        method: input.method,
        channelCode: input.channelCode ?? "VC",
        channelName: channel?.name ?? "Credit Card",
        paymentUrl: `https://pay.example.test/${providerRef}`,
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226NQF${n}`,
        issuer: null,
      };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
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
}

let fx: HoldFixture;
const gw = new FlakyGateway();

beforeAll(async () => {
  fx = await holdFixture("qr-va-1004-nqfov");
  // E-wallet and card have no default route (fail closed): switch them on.
  for (const method of ["ewallet", "card"]) {
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')
       ON CONFLICT DO NOTHING`,
      [fx.tenant.tenantId, method],
    );
  }
  setPaymentGateway(gw); // after the fixture: it installs its own gateway
}, 180_000);

afterEach(async () => {
  await setRouting("ewallet", true);
  await setRouting("card", true);
});

afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Variant = {
  label: string;
  method: "ewallet" | "card";
  channel?: string;
  /** A payload that differs from this variant's (same key must be refused). */
  other: { method: "ewallet" | "card" | "va"; channel?: string };
};

const VARIANTS: Variant[] = [
  {
    label: "e-wallet",
    method: "ewallet",
    channel: "OV",
    other: { method: "ewallet", channel: "DA" },
  },
  {
    label: "card",
    method: "card",
    other: { method: "ewallet", channel: "OV" },
  },
];

const payOrder = (
  guest: Guest,
  orderId: string,
  method: "qris" | "va" | "ewallet" | "card",
  channel: string | undefined,
  idempotencyKey: string,
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(channel === undefined ? {} : { bankCode: channel }),
    idempotencyKey,
  });

async function setRouting(method: string, enabled: boolean) {
  await owner.query(
    "UPDATE payment_routing_rules SET enabled = $3 WHERE tenant_id = $1 AND method = $2",
    [fx.tenant.tenantId, method, enabled],
  );
}

async function releaseCount(intentId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM payment_va_releases WHERE tenant_id = $1 AND payment_intent_id = $2",
    [fx.tenant.tenantId, intentId],
  );
  return rows.length;
}

/** The guest's first request worked; its answer is "lost" (we keep only the key). */
async function firstCall(variant: Variant) {
  gw.reset();
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const key = randomUUID();
  const first = await payOrder(
    guest,
    order.id,
    variant.method,
    variant.channel,
    key,
  );
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body.data.status).toBe("pending");
  return { guest, order, key, first };
}

type Break = { name: string; apply: () => Promise<void> };
const BREAKS = (variant: Variant): Break[] => [
  {
    name: "gateway methods() throws",
    apply: async () => {
      gw.failMethods = true;
    },
  },
  {
    name: "the method is switched off at the gateway",
    apply: async () => {
      gw.setEnabled(variant.method, false);
    },
  },
  {
    name: "tenant routing for the method is disabled",
    apply: async () => {
      await setRouting(variant.method, false);
    },
  },
];

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

for (const variant of VARIANTS) {
  describe(`legend-nqfov ${variant.label} replay does not depend on the method being available now`, () => {
    for (const brk of BREAKS(variant)) {
      it(`legend-nqfov ${variant.label}: ${brk.name}, same key + same payload returns the same pending intent and URL; one provider create, no void`, async () => {
        const { guest, order, key, first } = await firstCall(variant);
        const id = first.body.data.id as string;
        const intents = await intentCount(fx.tenant.tenantId);
        await brk.apply();

        const retry = await payOrder(
          guest,
          order.id,
          variant.method,
          variant.channel,
          key,
        );

        expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(300);
        expect(retry.body.data.id).toBe(id);
        expect(retry.body.data.status).toBe("pending");
        expect(retry.body.data.redirectUrl).toBe(first.body.data.redirectUrl);
        expect(typeof retry.body.data.redirectUrl).toBe("string");
        expect(gw.created, "no second provider create").toHaveLength(1);
        expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
          intents,
        );
        expect(await releaseCount(id), "no void").toBe(0);
        expect((await intentRow(fx.tenant.tenantId, id)).status).toBe(
          "pending",
        );
      });
    }

    it(`legend-nqfov ${variant.label}: methods() throws, same key + different payload is 409 IDEMPOTENCY_KEY_REUSED, nothing created`, async () => {
      const { guest, order, key, first } = await firstCall(variant);
      const id = first.body.data.id as string;
      const intents = await intentCount(fx.tenant.tenantId);
      gw.failMethods = true;

      const retry = await payOrder(
        guest,
        order.id,
        variant.other.method,
        variant.other.channel,
        key,
      );

      expect(retry.status, JSON.stringify(retry.body)).toBe(409);
      expect(errorCode(retry.body), JSON.stringify(retry.body)).toBe(
        "IDEMPOTENCY_KEY_REUSED",
      );
      expect(gw.created, "no second provider create").toHaveLength(1);
      expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
      expect(await releaseCount(id), "no void").toBe(0);
      expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("pending");
    });

    it(`legend-nqfov ${variant.label}: a NEW key while the method is disabled is still rejected 400, no provider request, no intent`, async () => {
      gw.reset();
      gw.setEnabled(variant.method, false);
      const guest = await fx.newGuest();
      const order = await fx.qrOrder(guest);
      const intents = await intentCount(fx.tenant.tenantId);

      const res = await payOrder(
        guest,
        order.id,
        variant.method,
        variant.channel,
        randomUUID(),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(gw.created, "no provider request").toHaveLength(0);
      expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    });

    it(`legend-nqfov ${variant.label}: a NEW key while methods() throws creates nothing (no provider request, no intent)`, async () => {
      gw.reset();
      gw.failMethods = true;
      const guest = await fx.newGuest();
      const order = await fx.qrOrder(guest);
      const intents = await intentCount(fx.tenant.tenantId);

      const res = await payOrder(
        guest,
        order.id,
        variant.method,
        variant.channel,
        randomUUID(),
      );

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(gw.created, "no provider request").toHaveLength(0);
      expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    });

    it(`legend-nqfov ${variant.label}: a replay of a closed code (voided by a swap to VA) stays closed while methods() throws: no pay URL, no new code`, async () => {
      const { guest, order, key, first } = await firstCall(variant);
      const url = first.body.data.redirectUrl as string;
      const providerRef = gw.created[0]!.providerRef;
      const swapped = await payOrder(guest, order.id, "va", "BC", randomUUID());
      expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
      const created = gw.created.length;
      const intents = await intentCount(fx.tenant.tenantId);
      gw.failMethods = true;

      const replay = await payOrder(
        guest,
        order.id,
        variant.method,
        variant.channel,
        key,
      );

      expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);
      if (replay.status < 300) {
        expect(replay.body.data.redirectUrl).toBeNull();
        expect(replay.body.data.status).not.toBe("pending");
      }
      expect(JSON.stringify(replay.body)).not.toContain(url);
      expect(JSON.stringify(replay.body)).not.toContain(providerRef);
      expect(gw.created, "no new provider create").toHaveLength(created);
      expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
        intents,
      );
      expect(
        (await intentRow(fx.tenant.tenantId, first.body.data.id)).status,
        "the closed code is not reopened",
      ).toBe("expired");
    });

    it(`legend-nqfov ${variant.label}: a replay of an expired code stays closed while the method is switched off: no pay URL, not reopened`, async () => {
      const { guest, order, key, first } = await firstCall(variant);
      const id = first.body.data.id as string;
      const url = first.body.data.redirectUrl as string;
      await owner.query(
        `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes',
                provider_final_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [fx.tenant.tenantId, id],
      );
      const intents = await intentCount(fx.tenant.tenantId);
      await setRouting(variant.method, false);

      const replay = await payOrder(
        guest,
        order.id,
        variant.method,
        variant.channel,
        key,
      );

      expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);
      if (replay.status < 300) {
        expect(replay.body.data.redirectUrl).toBeNull();
        expect(replay.body.data.status).not.toBe("pending");
      }
      expect(JSON.stringify(replay.body)).not.toContain(url);
      expect(gw.created, "no new provider create").toHaveLength(1);
      expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
      expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("expired");
    });
  });
}
