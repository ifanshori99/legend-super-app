// legend-ukbq3: the shared helper `confirmLinkUnpaidAtProvider(context, linkId,
// now)` of services/payment-provider-proof.ts, tested alone (no call site).
// Contract from docs/briefs/ukbq3-payment-link-cancel.md "Desain":
//  - provider paid (same reference): payment applied once -> "settled"
//  - provider pending / expired / failed: nothing is paid there -> "unpaid".
//    The helper never calls the gateway `cancel` (review 1 finding 3: a close
//    the caller later refuses must not cancel the QR at the provider)
//  - provider says paid but the settle did not apply it (second status read
//    fails): 409 too, never "settled" (review 1 finding 1)
//  - status read throws or answers another reference: rejects HttpError 409
//    PAYMENT_PROVIDER_UNCONFIRMED, nothing changes, no cancel call
//  - a link without any provider-side intent: "unpaid", no provider call
//
// Assumptions: the optional gateway `cancel` is observed with a subclass that
// records its argument, to assert it is NEVER called; "applied once" is asserted as one `payment_evidence` row, intent
// `paid`, nothing parked and nothing refunded, even if the helper runs twice.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmLinkUnpaidAtProvider } from "../services/payment-provider-proof.ts";
import {
  createIntent,
  createPaymentLink,
} from "../services/payment.service.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";
import {
  PROVIDER_UNSURE,
  expectLinkActive,
  expectNoMoneyMoved,
  intentInfo,
  moneyOfIntent,
  settleCall,
  expectUnconfirmedError,
} from "./payment-link-cancel-provider-helpers.ts";
import { ScriptedGateway } from "./pos-qris-hold-test-helpers.ts";

const AMOUNT = 50_000;
const REF_PREFIX = "ukbq3h-"; // payment link reference is capped at 40 chars
const outletA = outletIdSchema.parse(seededOutletA);

/** Scripted provider that also records provider-side cancels (must stay empty). */
class CancelGateway extends ScriptedGateway {
  readonly cancels: unknown[] = [];
  /** Intents whose answer also reports a paid transaction under another reference (908). */
  readonly withExtras = new Set<string>();
  async cancel(input: unknown) {
    this.cancels.push(input);
  }
  override async getStatus(input: { providerRef: string; intentId?: string }) {
    const base = await super.getStatus(input);
    return input.intentId && this.withExtras.has(input.intentId)
      ? {
          ...base,
          extraPayments: [
            { providerRef: `EXTRA-${randomUUID()}`, amountIdr: 7_000 },
          ],
        }
      : base;
  }
}

let gateway: CancelGateway;

const context = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  gateway = new CancelGateway("doit");
  setPaymentGateway(gateway);
});

afterAll(async () => {
  setPaymentGateway(null);
  await asOwner(async (client) => {
    const links = `(SELECT id FROM payment_links WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%')`;
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id IN ${links})`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId],
      );
    await client.query(
      `DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id IN ${links}`,
      [seededTenantId],
    );
    await client.query(
      `DELETE FROM payment_links WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%'`,
      [seededTenantId],
    );
  });
  await owner.end();
});

async function newLink(withIntent: boolean) {
  const opened = await createPaymentLink(
    context(),
    {
      outletId: outletA,
      reference: `${REF_PREFIX}${randomUUID().slice(0, 12)}`,
      tableLabel: "T-uji",
      pax: 2,
      subtotalIdr: AMOUNT,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: AMOUNT,
      returnPath: null,
    },
    "system:qr-order",
  );
  let intentId: string | null = null;
  if (withIntent) {
    const intent = await createIntent(context(), opened.token, {
      method: "qris",
      channelCode: null,
      idempotencyKey: randomUUID(),
    });
    intentId = intent.id;
  }
  return { linkId: opened.linkId, intentId };
}

async function evidenceCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
    [seededTenantId, intentId],
  );
  return rows[0]!.n;
}

describe("legend-ukbq3 confirmLinkUnpaidAtProvider", () => {
  it("ukbq3-helper-paid: provider has the money -> settled, the payment is applied once, no cancel call", async () => {
    const { linkId, intentId } = await newLink(true);
    gateway.script(intentId!, { rawStatus: "00", amountIdr: AMOUNT });
    const cancelsBefore = gateway.cancels.length;

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("settled");

    expect((await intentInfo(seededTenantId, intentId!)).status).toBe("paid");
    expect(await evidenceCount(intentId!)).toBe(1);
    expect(gateway.cancels).toHaveLength(cancelsBefore);
    expectNoMoneyMoved(
      "settled link",
      await moneyOfIntent(seededTenantId, intentId!),
    );

    // Run again (a retried cancel): the same money is never applied twice.
    await settleCall(
      confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    );
    expect(await evidenceCount(intentId!)).toBe(1);
    expect((await intentInfo(seededTenantId, intentId!)).status).toBe("paid");
    expectNoMoneyMoved(
      "settled link, second run",
      await moneyOfIntent(seededTenantId, intentId!),
    );
  });

  for (const raw of ["01", "02"] as const) {
    it(`ukbq3-helper-unpaid: provider says ${raw === "01" ? "pending" : "expired"} -> unpaid, nothing applied, the provider cancel is not called`, async () => {
      const { linkId, intentId } = await newLink(true);
      gateway.script(intentId!, { rawStatus: raw });
      const before = gateway.cancels.length;

      expect(
        await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
      ).toBe("unpaid");

      expect(gateway.cancels).toHaveLength(before);
      expect((await intentInfo(seededTenantId, intentId!)).status).toBe(
        "pending",
      );
      expect(await evidenceCount(intentId!)).toBe(0);
    });
  }

  it("908-helper-extra-paid: provider reports another reference paid on the code -> 409 PAYMENT_PROVIDER_UNCONFIRMED, nothing changes, no cancel call", async () => {
    const { linkId, intentId } = await newLink(true);
    gateway.script(intentId!, { rawStatus: "01" });
    gateway.withExtras.add(intentId!);
    const before = gateway.cancels.length;

    const result = await settleCall(
      confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    );

    expectUnconfirmedError(result, "other reference paid");
    expect(gateway.cancels).toHaveLength(before);
    expect((await intentInfo(seededTenantId, intentId!)).status).toBe(
      "pending",
    );
    await expectLinkActive(seededTenantId, intentId!, "other reference paid");
    expect(await evidenceCount(intentId!)).toBe(0);
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`ukbq3-helper-unconfirmed: provider answer ${JSON.stringify(answer)} -> 409 PAYMENT_PROVIDER_UNCONFIRMED, nothing changes, no cancel call`, async () => {
      const { linkId, intentId } = await newLink(true);
      gateway.script(intentId!, answer);
      const before = gateway.cancels.length;

      const result = await settleCall(
        confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
      );

      expectUnconfirmedError(result, "unsure provider");
      expect(gateway.readsOf(intentId!).length).toBeGreaterThanOrEqual(1);
      expect(gateway.cancels).toHaveLength(before);
      expect((await intentInfo(seededTenantId, intentId!)).status).toBe(
        "pending",
      );
      await expectLinkActive(seededTenantId, intentId!, "unsure provider");
      expect(await evidenceCount(intentId!)).toBe(0);
      expectNoMoneyMoved(
        "unsure provider",
        await moneyOfIntent(seededTenantId, intentId!),
      );
    });
  }

  it("ukbq3-helper-settle-fails: provider says paid, then the settle's own status read fails -> 409, never settled, nothing applied", async () => {
    const { linkId, intentId } = await newLink(true);
    // First read (the helper) says paid; the second read (the settle) fails.
    gateway.queue(
      intentId!,
      { rawStatus: "00", amountIdr: AMOUNT },
      { error: "timeout" },
    );
    gateway.script(intentId!, { error: "timeout" });
    const before = gateway.cancels.length;

    const result = await settleCall(
      confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    );

    expectUnconfirmedError(result, "paid, then settle read failed");
    expect(gateway.cancels).toHaveLength(before);
    expect((await intentInfo(seededTenantId, intentId!)).status).toBe(
      "pending",
    );
    await expectLinkActive(seededTenantId, intentId!, "settle read failed");
    expect(await evidenceCount(intentId!)).toBe(0);
    expectNoMoneyMoved(
      "settle read failed",
      await moneyOfIntent(seededTenantId, intentId!),
    );
  });

  it("ukbq3-helper-empty: a link nobody opened a QR on -> unpaid without any provider call", async () => {
    const { linkId } = await newLink(false);
    const reads = gateway.statusReads.length;
    const cancels = gateway.cancels.length;

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("unpaid");

    expect(gateway.statusReads).toHaveLength(reads);
    expect(gateway.cancels).toHaveLength(cancels);
  });
});
