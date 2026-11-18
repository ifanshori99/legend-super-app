// legend-p45yq (brief 1004, second-opinion P2): two requests with the SAME
// idempotency key K ask for another bank while a live VA code O exists. Request
// A voids O and stores the new intent N (key K). Request B had already looked
// for K (found nothing) and is held inside the "void the old code" hook; when it
// resumes, N is there with the choice B asked for. B must answer as a replay
// (the same intent N), never 409 ORDER_CODE_ACTIVE (the gp3fw replay contract).
// Different fingerprint with the same key stays IDEMPOTENCY_KEY_REUSED.
//
// Written from the brief and the public payment contract. The hook window is
// not reachable over HTTP, so the race is a service-level test: createIntent is
// called directly (as the public token route does) and B's
// `voidLiveCodesForChange` option is a wrapper that waits on a deferred gate
// before delegating to the real voidLiveCodesForMethodChange. No sleeps for
// ordering: B signals when it is inside the hook, A runs to completion, then
// the gate opens.
//
// Assumptions (the brief does not fix them):
// - A replay returns the stored intent N (same id). Status is not an HTTP one.
// - "No balance / parked-fund change": no payment_unallocated_funds row, no
//   pos_qris_holds row, no payment_va_releases row for N, every intent keeps
//   the bill's amount, the provider is asked for exactly one new code (A's)
//   and is never asked to cancel N.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-1004-p45yq-same-key-method-change.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  idr,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { agent } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  bindLinkToOrder,
  expectRefusal,
  holdStates,
  intentRow,
} from "./qr-va-912-3p1-helpers.ts";
import { createIntent } from "../services/payment.service.ts";
import { voidLiveCodesForMethodChange } from "../services/payment-va-release.ts";
import {
  setPaymentGateway,
  type GatewayCancelRequest,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BANK_NAMES: Record<string, string> = {
  bmri: "Mandiri",
  bnia: "CIMB Niaga",
  bca: "BCA",
};

/** Provider double: VA (two banks), bank transfer (one bank). Counts calls. */
class Gateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly created: GatewayIntentRequest[] = [];
  readonly cancels: GatewayCancelRequest[] = [];
  private sequence = 0;
  readonly cancel = async (
    _context: ScopedTenantContext,
    intent: GatewayCancelRequest,
  ) => {
    this.cancels.push(intent);
  };
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `P45-${randomUUID()}`;
    this.created.push(input);
    const code = input.channelCode ?? "bmri";
    let instructions: PaymentInstructions;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: code,
        channelName: BANK_NAMES[code] ?? code,
        virtualAccountNumber: `8808${n}`,
      };
    else if (input.method === "bank_transfer")
      instructions = {
        method: "bank_transfer",
        channelCode: code,
        channelName: BANK_NAMES[code] ?? code,
        accountNumber: `7700${n}`,
        accountHolder: "PT Legend Test",
        uniqueCode: "123",
        transferTotalIdr: idr(input.amountIdr + 123),
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226P45${n}`,
        issuer: null,
      };
    return { providerRef, instructions, expiresAt: input.expiresAt };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels(_context: unknown, method?: string) {
    if (method === "va")
      return [
        { code: "bmri", name: "Mandiri" },
        { code: "bnia", name: "CIMB Niaga" },
      ];
    if (method === "bank_transfer") return [{ code: "bca", name: "BCA" }];
    return [];
  }
}

let fx: HoldFixture;
const gw = new Gateway();
beforeAll(async () => {
  fx = await holdFixture("qr-va-1004-p45yq");
  setPaymentGateway(gw);
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

const postLink = (
  token: string,
  method: "qris" | "va" | "bank_transfer",
  channelCode: string | null,
  idempotencyKey: string,
) =>
  agent(fx.app)
    .post(`/api/payments/links/${token}/intents`)
    .send({ method, channelCode, idempotencyKey });

/** A bill with a public token and one live Mandiri VA (O). */
async function billWithLiveVa(bank = "bmri") {
  const order = await newSubmittedOrder(fx, 0);
  const { token, linkId } = await bindLinkToOrder(fx, order);
  const first = await postLink(token, "va", bank, randomUUID());
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  return {
    order,
    orderUuid: ulidToUuid(order.id),
    token,
    linkId,
    oldId: first.body.data.id as string,
  };
}

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
) {
  return (await owner.query<T>(sql, params)).rows;
}

const intentsOnLinkWithStatus = (linkId: string) =>
  rows<{ id: string; status: string; idempotency_key: string }>(
    `SELECT id::text AS id, status, idempotency_key FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2 ORDER BY created_at, id`,
    [fx.tenant.tenantId, linkId],
  );

async function releaseCount(intentId: string) {
  const found = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_va_releases
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return found[0]!.n;
}

describe("legend-p45yq: same key, a twin voided the old code and stored the new one while the request was held in the void hook", () => {
  it("legend-p45yq the held request is answered as a replay: the same intent N, one new code, no money moved, no extra intent", async () => {
    const b = await billWithLiveVa();
    const key = randomUUID();
    const input = {
      method: "va",
      channelCode: "bnia",
      idempotencyKey: key,
    } as const;
    const created = gw.created.length;

    // Request B: its hook signals "entered" (its twin read already found
    // nothing), then waits on the gate before the real void runs.
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const requestB = createIntent(fx.context, b.token, input, new Date(), {
      voidLiveCodesForChange: async (scope) => {
        enter();
        await gate;
        return voidLiveCodesForMethodChange(fx.context, scope);
      },
    }).then(
      (intent) => ({ intent, error: null as unknown }),
      (error: unknown) => ({ intent: null, error }),
    );
    await entered;

    // Request A: same key, real hook; voids O and stores N.
    const a = await createIntent(fx.context, b.token, input, new Date(), {
      voidLiveCodesForChange: (scope) =>
        voidLiveCodesForMethodChange(fx.context, scope),
    });
    expect(a.method).toBe("va");

    open();
    const answer = await requestB;

    expect(
      answer.error,
      `B must replay N, got ${String((answer.error as { code?: string } | null)?.code ?? answer.error)}`,
    ).toBeNull();
    expect(answer.intent?.id, "B gets A's intent N back").toBe(a.id);

    // Exactly one new code: N is the only live one, O stays voided.
    const intents = await intentsOnLinkWithStatus(b.linkId);
    expect(intents.map((row) => [row.id, row.status])).toEqual([
      [b.oldId, "expired"],
      [a.id, "pending"],
    ]);
    expect(
      intents.filter((row) => row.idempotency_key === key),
      "one intent for the key",
    ).toHaveLength(1);
    expect(
      gw.created.length,
      "the provider is asked for exactly one new code (A's)",
    ).toBe(created + 1);
    const newRef = (await intentRow(fx.tenant.tenantId, a.id))
      .provider_ref as string;
    expect(
      gw.cancels.map((cancel) => cancel.providerRef),
      "the replay never cancels N",
    ).not.toContain(newRef);

    // No balance or parked-fund change.
    expect(await unallocatedFunds(fx)).toEqual([]);
    expect(await holdStates(fx.tenant.tenantId, b.orderUuid)).toEqual([]);
    expect(await releaseCount(a.id), "N is not voided").toBe(0);
    const amounts = await rows<{ amount_idr: number }>(
      `SELECT amount_idr::int AS amount_idr FROM payment_intents
        WHERE tenant_id = $1 AND payment_link_id = $2`,
      [fx.tenant.tenantId, b.linkId],
    );
    for (const row of amounts) expect(row.amount_idr).toBe(b.order.totalIdr);
  });
});

describe("legend-p45yq: guards that stay", () => {
  it("legend-p45yq the same key with ANOTHER choice than the stored intent is still 409 IDEMPOTENCY_KEY_REUSED, not a replay, and nothing is voided", async () => {
    const b = await billWithLiveVa();
    const key = randomUUID();
    const swapped = await postLink(b.token, "va", "bnia", key);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    const created = gw.created.length;
    const intents = await intentsOnLinkWithStatus(b.linkId);

    const reused = await postLink(b.token, "bank_transfer", "bca", key);

    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(
      (reused.body as { error?: { code?: string } }).error?.code,
      JSON.stringify(reused.body),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(gw.created.length, "no provider call").toBe(created);
    expect(await intentsOnLinkWithStatus(b.linkId)).toEqual(intents);
    expect((await intentRow(fx.tenant.tenantId, newId)).status).toBe("pending");
    expect(await releaseCount(newId)).toBe(0);
  });

  it("legend-p45yq the same key and the same choice later (no race) replays 201 with the same intent, no void, no new code", async () => {
    const b = await billWithLiveVa();
    const key = randomUUID();
    const first = await postLink(b.token, "va", "bnia", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const created = gw.created.length;
    const intents = await intentsOnLinkWithStatus(b.linkId);

    const again = await postLink(b.token, "va", "bnia", key);

    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(gw.created.length).toBe(created);
    expect(await intentsOnLinkWithStatus(b.linkId)).toEqual(intents);
  });

  it("legend-p45yq a DIFFERENT key asking the live code's bank while a live code exists keeps the guard's own refusal or returns the live code, never a second live code", async () => {
    // Assumption: the brief does not pin this status (a same-choice swap with a
    // new key may return the live code); only that one code stays live.
    const b = await billWithLiveVa();
    const other = await postLink(b.token, "va", "bmri", randomUUID());
    if (other.status === 409) expectRefusal(other, "ORDER_CODE_ACTIVE");
    else expect(other.status, JSON.stringify(other.body)).toBeLessThan(300);
    const live = (await intentsOnLinkWithStatus(b.linkId)).filter(
      (row) => row.status === "pending",
    );
    expect(live).toHaveLength(1);
  });
});
