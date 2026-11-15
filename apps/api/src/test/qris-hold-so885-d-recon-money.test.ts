// SO-885 card D (legend-adiov): a force released QRIS whose webhook is lost is
// still found. The release opens a durable reconciliation row; the worker asks
// the provider until it answers for good, independent of the payment poller and
// of the 24 h intent timeout, and the money is recorded exactly once.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  payNotice,
  refundsOfIntent,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import {
  BILL_IDR,
  FUNDS_ALERT_TITLE,
  evidenceRows,
  hoursAfter,
  notificationCount,
  outboxCountOf,
  reconRows,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-d-money");
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function expectRecordedOnce(intentId: string) {
  expect(await evidenceRows(fx, intentId)).toHaveLength(1);
  const funds = await unallocatedFunds(fx, intentId);
  expect(funds).toHaveLength(1);
  expect(funds[0]!.amountIdr).toBe(BILL_IDR);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", intentId)).toBe(
    1,
  );
}

describe("SO-885 D-01 release while the provider is down, webhook lost for more than 24 h", () => {
  it("D-01 the worker finds the paid QR once; webhook and poll replays add nothing", async () => {
    const { orderId, qr, releasedAt } = await kit.forceRelease({
      error: "5xx",
    });
    const [row] = await reconRows(fx, qr.intentId);
    expect(row?.status).toBe("open");

    // Past the 24 h window with the provider down, the poller marks the intent
    // expired (timeout) and never selects it again.
    const later = hoursAfter(releasedAt, 25);
    await pollPendingGatewayIntents(fx.context, later, 100);
    const { rows: intents } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, qr.intentId],
    );
    expect(intents[0]?.status).toBe("expired");
    const polled = await pollPendingGatewayIntents(
      fx.context,
      hoursAfter(releasedAt, 26),
      100,
    );
    expect(polled.checked).toBe(0);

    // Provider still down: the row stays open, nothing is recorded.
    await runRecon(fx, hoursAfter(releasedAt, 26));
    const [down] = await reconRows(fx, qr.intentId);
    expect(down?.status).toBe("open");
    expect(down?.attempts).toBe(1);
    expect(down?.last_provider_status).toBe("unreachable");
    expect(await evidenceRows(fx, qr.intentId)).toEqual([]);

    // The provider recovers and says paid: found, parked, alerted, once.
    const alertsBefore = await notificationCount(fx, FUNDS_ALERT_TITLE);
    fx.gateway.script(qr.intentId, { status: "paid" });
    await runRecon(fx, hoursAfter(releasedAt, 26));
    await expectRecordedOnce(qr.intentId);
    expect(await notificationCount(fx, FUNDS_ALERT_TITLE)).toBeGreaterThan(
      alertsBefore,
    );
    const [done] = await reconRows(fx, qr.intentId);
    expect(done?.status).toBe("resolved");
    expect(done?.resolution).toBe("paid_recorded");
    expect(done?.resolved_at).not.toBeNull();

    // Replays: worker, verified webhook (same provider ref), poll.
    await runRecon(fx, hoursAfter(releasedAt, 27));
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      hoursAfter(releasedAt, 27),
      qr.providerRef!,
    ).catch(() => null);
    await pollPendingGatewayIntents(
      fx.context,
      hoursAfter(releasedAt, 28),
      100,
    );
    await expectRecordedOnce(qr.intentId);
    expect(await capturedIdr(fx, orderId)).toBe(0);
    expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
      "voided",
    ]);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
  });
});

describe("SO-885 D-02 the verified webhook or the poll comes first (BILL_CLOSED after force release)", () => {
  it("D-02 webhook first: parked once, the worker then resolves without a second record", async () => {
    const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      new Date(),
      qr.providerRef!,
    ).catch(() => null);
    await expectRecordedOnce(qr.intentId);
    fx.gateway.script(qr.intentId, { status: "paid" });
    await runRecon(fx, hoursAfter(releasedAt, 1));
    await expectRecordedOnce(qr.intentId);
    expect((await reconRows(fx, qr.intentId))[0]?.status).toBe("resolved");
  });

  it("D-02 poll first (inside its window): parked once, the worker adds nothing", async () => {
    const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
    fx.gateway.script(qr.intentId, { status: "paid" });
    await pollPendingGatewayIntents(fx.context, new Date(), 100);
    await runRecon(fx, hoursAfter(releasedAt, 1));
    await runRecon(fx, hoursAfter(releasedAt, 2));
    await expectRecordedOnce(qr.intentId);
    expect((await reconRows(fx, qr.intentId))[0]?.status).toBe("resolved");
  });
});

describe("SO-885 D-03 race: a new code is paid, then the old code is found", () => {
  it("D-03 the bill is captured once; the old code's money is parked, never applied", async () => {
    const { orderId, qr, releasedAt } = await kit.forceRelease({
      error: "timeout",
    });
    const second = await issueQris(fx, orderId);
    expect(second.amountIdr).toBe(BILL_IDR);
    await payNotice(fx, second.intentId, BILL_IDR);
    expect(await capturedIdr(fx, orderId)).toBe(BILL_IDR);

    fx.gateway.script(qr.intentId, { status: "paid" });
    await runRecon(fx, hoursAfter(releasedAt, 30));
    await runRecon(fx, hoursAfter(releasedAt, 31));
    expect(await capturedIdr(fx, orderId)).toBe(BILL_IDR);
    await expectRecordedOnce(qr.intentId);
  });
});

describe("SO-885 D-04 final non-paid answers and unknown answers", () => {
  it("D-04 expired or failed resolves the row without any money record", async () => {
    for (const [answer, resolution] of [
      [{ rawStatus: "02" as const }, "provider_expired"],
      [{ status: "failed" as const }, "provider_failed"],
    ] as const) {
      const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
      fx.gateway.script(qr.intentId, answer);
      await runRecon(fx, hoursAfter(releasedAt, 1));
      const [row] = await reconRows(fx, qr.intentId);
      expect(row?.status).toBe("resolved");
      expect(row?.resolution).toBe(resolution);
      expect(await evidenceRows(fx, qr.intentId)).toEqual([]);
    }
  });

  it("D-04 a pending answer keeps asking: attempts grow, the row stays open, a not-due row is skipped", async () => {
    const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
    await runRecon(fx, hoursAfter(releasedAt, 1));
    await runRecon(fx, hoursAfter(releasedAt, 2));
    const [row] = await reconRows(fx, qr.intentId);
    expect(row?.status).toBe("open");
    expect(row?.attempts).toBe(2);
    expect(row?.last_provider_status).toBe("pending");
    const reads = fx.gateway.readsOf(qr.intentId).length;
    // Not due yet: a non-forced run right after reads nothing.
    await runRecon(fx, hoursAfter(releasedAt, 2), { force: false });
    expect(fx.gateway.readsOf(qr.intentId).length).toBe(reads);
  });
});
