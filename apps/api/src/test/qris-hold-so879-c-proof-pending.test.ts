// so-879 P3: provider proof for a code that is `expired` only in OUR books.
// A superseded or locally closed intent can be payable at the provider until
// its own lifetime runs out. A `pending` answer for such a code is not proof
// that it holds no money, so the link must not be closed on it (fail closed,
// 409 PAYMENT_PROVIDER_UNCONFIRMED). Safe only when the provider says
// expired/failed, or the code's own expires_at + 60 s has passed.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so879-c-proof-pending.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
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
  expectNoMoneyMoved,
  expectUnconfirmedError,
  intentInfo,
  moneyOfIntent,
  settleCall,
} from "./payment-link-cancel-provider-helpers.ts";
import { ScriptedGateway } from "./pos-qris-hold-test-helpers.ts";

const AMOUNT = 50_000;
const REF_PREFIX = "so879pp-";
const outletA = outletIdSchema.parse(seededOutletA);

let gateway: ScriptedGateway;

const context = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  gateway = new ScriptedGateway("doit");
  setPaymentGateway(gateway);
});

afterAll(async () => {
  setPaymentGateway(null);
  const links = `(SELECT id FROM payment_links WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%')`;
  const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id IN ${links})`;
  for (const table of [
    "payment_refunds",
    "payment_evidence",
    "payment_unallocated_funds",
  ])
    await owner.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
      [seededTenantId],
    );
  await owner.query(
    `DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id IN ${links}`,
    [seededTenantId],
  );
  await owner.query(
    `DELETE FROM payment_links WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%'`,
    [seededTenantId],
  );
  await owner.end();
});

/** A QRIS intent that reached the provider, then closed LOCALLY (`expired`)
 * with `expiresInSeconds` of its own lifetime left (negative: lapsed). */
async function locallyExpiredCode(expiresInSeconds: number) {
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
  const intent = await createIntent(context(), opened.token, {
    method: "qris",
    channelCode: null,
    idempotencyKey: randomUUID(),
  });
  await owner.query(
    `UPDATE payment_intents
        SET status = 'expired',
            expires_at = now() + ($3::int * interval '1 second')
      WHERE tenant_id = $1 AND id = $2`,
    [seededTenantId, intent.id, expiresInSeconds],
  );
  const info = await intentInfo(seededTenantId, intent.id);
  expect(info.status).toBe("expired");
  expect(info.providerRef).not.toBeNull();
  return { linkId: opened.linkId, intentId: intent.id };
}

describe("so-879 P3 provider proof, locally expired code", () => {
  it("pending at the provider and the code has not lapsed -> 409, nothing applied", async () => {
    const { linkId, intentId } = await locallyExpiredCode(120);
    gateway.script(intentId, { rawStatus: "01" });

    expectUnconfirmedError(
      await settleCall(
        confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
      ),
      "locally expired, provider pending",
    );

    expect((await intentInfo(seededTenantId, intentId)).status).toBe("expired");
    expectNoMoneyMoved(
      "locally expired, provider pending",
      await moneyOfIntent(seededTenantId, intentId),
    );
  });

  it("pending at the provider and the code lapsed 30 s ago (inside the 60 s margin) -> 409", async () => {
    const { linkId, intentId } = await locallyExpiredCode(-30);
    gateway.script(intentId, { rawStatus: "01" });

    expectUnconfirmedError(
      await settleCall(
        confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
      ),
      "lapsed inside the margin, provider pending",
    );
  });

  it("pending at the provider but the code lapsed past the margin -> unpaid", async () => {
    const { linkId, intentId } = await locallyExpiredCode(-120);
    gateway.script(intentId, { rawStatus: "01" });

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("unpaid");
  });

  it("provider says expired for a code that has not lapsed -> unpaid", async () => {
    const { linkId, intentId } = await locallyExpiredCode(120);
    gateway.script(intentId, { rawStatus: "02" });

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("unpaid");
  });

  it("provider says failed for a code that has not lapsed -> unpaid", async () => {
    const { linkId, intentId } = await locallyExpiredCode(120);
    gateway.script(intentId, { status: "failed" });

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("unpaid");
  });

  it("provider says paid for the locally expired code -> settled once", async () => {
    const { linkId, intentId } = await locallyExpiredCode(120);
    gateway.script(intentId, { rawStatus: "00", amountIdr: AMOUNT });

    expect(
      await confirmLinkUnpaidAtProvider(context(), linkId, new Date()),
    ).toBe("settled");
    expect((await intentInfo(seededTenantId, intentId)).status).toBe("paid");
  });
});
