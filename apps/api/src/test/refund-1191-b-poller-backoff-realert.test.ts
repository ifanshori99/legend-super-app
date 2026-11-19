// (brief 1191 card 2 = legend-rdg29, tier K "jangan sampai rugi"): red-first tests, written from
// docs/briefs/1191-refund-hold-hardening.md and the pattern of
// refund-1045-a-no-webhook-failed-own.test.ts, on top of refund-1072-harness, not from the
// implementation.
//
// Rule under test: a hold of reason `own_refund_failed_unverified` (our refund R was sent, then
// failed; the provider may have refunded on its own) stays OPEN until finance closes it. The
// poller keeps asking the provider about the main transaction, but with a BACK-OFF by the age of
// the hold (refund_recon_holds.flagged_at) instead of every minute forever, and finance is
// reminded again, at most once per calendar day, while the hold is still open. A provider answer
// `paid` or an error never closes the hold.
//
// Schedule used by the tests (the brief says "mis."; the tests only use values far from any
// reasonable boundary, so the exact numbers of the engineer may differ):
//   hold younger than 1 hour   : due again after about 1 minute   (tested at 2 minutes)
//   hold 1 hour .. 24 hours old: NOT due after 2 minutes, due after 30 minutes (tested at 2 and 30 minutes)
//   hold older than 24 hours   : NOT due after 30 minutes, due after 3 hours   (tested at 30 minutes and 3 hours)
//   never gives up (no cap on the number of questions), a provider error is retried later.
//
// Assumptions (the brief does not fix them):
//  - The time of the poller is its `at` argument, the last look is intents.gateway_polled_at
//    (set directly by the tests, lease cleared), the hold age is flagged_at (set directly).
//  - "asked" = the fake DOIT received `GET /v1/payments/<ref>` for that payment.
//  - The re-alert is raised by a poller pass (the brief does not say who triggers it). It reaches
//    the same recipients as the first alert (the tests count the notifications of the tenant per
//    user, so title and category are not pinned). Alert tests use a fixed `at` at 05:00 UTC
//    (noon in Jakarta) so a calendar-day key cannot be split by a test running at midnight.
//    Within the same calendar day: exactly one extra alert; the next day: one more. A hold
//    younger than 1 hour is never re-alerted.
//  - Tenant isolation: tenant B has its own bill and a seeded open hold (no staff roster);
//    the polls and alerts of one tenant never touch the other's hold or notifications.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1191-b-poller-backoff-realert.test.ts" heavy pnpm test

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { applyRefundProviderUpdate } from "../services/payment-refund.service";
import { pollPendingGatewayIntents } from "../services/payment.service";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1191b");
const OWN_FAILED = "own_refund_failed_unverified";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const tenantContext = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: h.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

beforeEach(async () => {
  h.doit.getFailsWith = null;
  // Each test sees only its own holds (their alerts and questions are counted).
  await h.owner.query("DELETE FROM refund_recon_holds WHERE tenant_id = $1", [
    h.tenantId,
  ]);
});
afterEach(() => {
  h.doit.getFailsWith = null;
});

/** Our refund R of the bill is sent (ref R), then fails: ONE open own-failed hold. */
async function heldBill() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const filed = await h.manualRefund(code.id, BILL_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  h.fake.enqueue("pending");
  expect((await h.approveRefund(refundId)).status).toBe(200);
  const ref = (await h.refundRow(refundId)).provider_ref;
  expect(ref, "premise: R was sent").toBeTruthy();
  await applyRefundProviderUpdate(tenantContext(), {
    providerRef: ref!,
    status: "failed",
    code: "declined",
  });
  expect((await h.refundRow(refundId)).status, "premise: R failed").toBe(
    "failed",
  );
  const holds = await h.openOf(code.id);
  expect(holds, "premise: one open hold").toHaveLength(1);
  expect(holds[0]!.reason).toBe(OWN_FAILED);
  return { code, holdId: holds[0]!.id, callsAfterFailure: h.fake.calls.length };
}

/** The hold is `ageMs` old at `at`; the intent was last looked at `gapMs` before `at`. */
async function schedule(
  held: { code: Code; holdId: string },
  at: Date,
  ageMs: number,
  gapMs: number,
) {
  await h.owner.query(
    "UPDATE refund_recon_holds SET flagged_at = $2 WHERE tenant_id = $1 AND id = $3",
    [h.tenantId, new Date(at.getTime() - ageMs), held.holdId],
  );
  await h.owner.query(
    `UPDATE payment_intents SET gateway_polled_at = $2, gateway_poll_lease_until = NULL
      WHERE tenant_id = $1 AND id = $3`,
    [h.tenantId, new Date(at.getTime() - gapMs), held.code.id],
  );
}

const lookupsOf = (providerRef: string) => h.doit.lookups.get(providerRef) ?? 0;

/** Runs the poller at `at` and returns how often the provider was asked about the bill. */
async function pollAndCount(code: Code, at: Date): Promise<number> {
  const before = lookupsOf(code.providerRef);
  await pollPendingGatewayIntents(tenantContext(), at, 100).catch(() => null);
  return lookupsOf(code.providerRef) - before;
}

async function expectStillHeld(
  held: { code: Code; holdId: string; callsAfterFailure: number },
  label: string,
) {
  const holds = await h.allHolds(held.code.id);
  expect(holds, `${label}: still one hold`).toHaveLength(1);
  expect(holds[0]!.id).toBe(held.holdId);
  expect(
    holds[0]!.resolved_at,
    `${label}: the system never closes it`,
  ).toBeNull();
  expect(holds[0]!.resolution).toBeNull();
  for (const amount of [BILL_IDR, 1_000]) {
    const attempt = await h.manualRefund(held.code.id, amount);
    if (attempt.status === 201) {
      const approved = await h.approveRefund(attempt.body.data.id as string);
      expect(
        [409, 422],
        `${label}: approving ${amount}: ${JSON.stringify(approved.body)}`,
      ).toContain(approved.status);
    } else {
      expect(
        [409, 422],
        `${label}: requesting ${amount}: ${JSON.stringify(attempt.body)}`,
      ).toContain(attempt.status);
    }
  }
  expect(h.fake.calls, `${label}: no second payout`).toHaveLength(
    held.callsAfterFailure,
  );
}

describe("legend-rdg29 poller back-off by the age of the hold", () => {
  it("1191-b-01 a young hold (10 minutes) is due again 2 minutes after the last look: the provider is asked", async () => {
    const held = await heldBill();
    const at = new Date();
    await schedule(held, at, 10 * MINUTE, 2 * MINUTE);

    expect(
      await pollAndCount(held.code, at),
      "young hold: asked after 2 minutes",
    ).toBeGreaterThanOrEqual(1);
    await expectStillHeld(held, "young hold");
  });

  it("1191-b-02 a hold of 2 hours is NOT asked 2 minutes after the last look, but is asked after 30 minutes", async () => {
    const held = await heldBill();
    const at = new Date();

    await schedule(held, at, 2 * HOUR, 2 * MINUTE);
    expect(
      await pollAndCount(held.code, at),
      "2 hours old, last look 2 minutes ago: backed off",
    ).toBe(0);

    await schedule(held, at, 2 * HOUR, 30 * MINUTE);
    expect(
      await pollAndCount(held.code, at),
      "2 hours old, last look 30 minutes ago: due",
    ).toBeGreaterThanOrEqual(1);
    await expectStillHeld(held, "hold of 2 hours");
  });

  it("1191-b-03 a hold of 3 days is NOT asked 30 minutes after the last look, but is asked after 3 hours", async () => {
    const held = await heldBill();
    const at = new Date();

    await schedule(held, at, 3 * DAY, 30 * MINUTE);
    expect(
      await pollAndCount(held.code, at),
      "3 days old, last look 30 minutes ago: backed off",
    ).toBe(0);

    await schedule(held, at, 3 * DAY, 3 * HOUR);
    expect(
      await pollAndCount(held.code, at),
      "3 days old, last look 3 hours ago: due",
    ).toBeGreaterThanOrEqual(1);
    await expectStillHeld(held, "hold of 3 days");
  });

  it("1191-b-04 the poller never gives up: a hold of 30 days is still asked, round after round, and a provider error is retried later; the hold stays open all along and nothing is paid out", async () => {
    const held = await heldBill();
    const at = new Date();

    for (let round = 0; round < 15; round += 1) {
      // From the 4th round the provider is down; from the 8th round it is back.
      h.doit.getFailsWith = round >= 3 && round < 8 ? 500 : null;
      await schedule(held, at, 30 * DAY, 3 * HOUR);
      expect(
        await pollAndCount(held.code, at),
        `round ${round + 1}: a hold of 30 days is still asked`,
      ).toBeGreaterThanOrEqual(1);
    }
    h.doit.getFailsWith = null;
    await expectStillHeld(held, "30 days, 15 rounds, provider down in between");
    // `paid` (the fake provider's answer all along) proves nothing: no fact either.
    expect(await h.providerRows(held.code.id), "no fact is guessed").toEqual(
      [],
    );
  });
});

describe("legend-rdg29 re-alert to finance while the hold is open", () => {
  /** Notifications of the tenant per recipient. */
  async function alertCounts(tenant: string = h.tenantId) {
    const { rows } = await h.owner.query<{ user_id: string; n: string }>(
      `SELECT user_id::text AS user_id, count(*)::text AS n FROM notifications
        WHERE tenant_id = $1 GROUP BY user_id`,
      [tenant],
    );
    return new Map(rows.map((row) => [row.user_id, Number(row.n)]));
  }
  /** The most any recipient received since `before`. */
  async function alertsSince(
    before: Map<string, number>,
    tenant: string = h.tenantId,
  ) {
    const now = await alertCounts(tenant);
    return Math.max(
      0,
      ...[...now].map(([user, n]) => n - (before.get(user) ?? 0)),
    );
  }

  // 05:00 UTC = noon in Jakarta: the same calendar day in both for the next hours.
  const T = new Date("2031-03-10T05:00:00Z");

  /** One poll pass at `at`; the intent is due and the hold is `ageMs` old at T. */
  async function passAt(
    held: { code: Code; holdId: string },
    at: Date,
    ageMs: number,
  ) {
    await schedule(held, at, ageMs + (at.getTime() - T.getTime()), 3 * HOUR);
    await pollPendingGatewayIntents(tenantContext(), at, 100).catch(() => null);
  }

  it("1191-b-05 a hold of 3 days that is still open is announced again: once on that day however often the poller runs, once more the next day", async () => {
    const before = await alertCounts();
    const held = await heldBill();
    expect(
      await alertsSince(before),
      "premise: the first alert went out when the hold was filed",
    ).toBeGreaterThanOrEqual(1);
    const afterFiling = await alertCounts();

    await passAt(held, T, 3 * DAY);
    expect(
      await alertsSince(afterFiling),
      "day 1: the open hold is announced again",
    ).toBe(1);

    await passAt(held, new Date(T.getTime() + 30 * MINUTE), 3 * DAY);
    await passAt(held, new Date(T.getTime() + 2 * MINUTE), 3 * DAY);
    expect(
      await alertsSince(afterFiling),
      "same calendar day: no second reminder (one dedupe key per day)",
    ).toBe(1);

    await passAt(held, new Date(T.getTime() + 25 * HOUR), 3 * DAY);
    expect(
      await alertsSince(afterFiling),
      "next calendar day: one more reminder",
    ).toBe(2);

    // The reminders never close or change the hold, and nothing is released.
    await expectStillHeld(
      { ...held, callsAfterFailure: held.callsAfterFailure },
      "after reminders",
    );
  });

  it("1191-b-06 a hold younger than 1 hour is not announced again by the poller, however often it runs", async () => {
    const held = await heldBill();
    const afterFiling = await alertCounts();

    for (let step = 0; step < 6; step += 1)
      await passAt(
        held,
        new Date(T.getTime() + step * 2 * MINUTE),
        20 * MINUTE,
      );

    expect(
      await alertsSince(afterFiling),
      "young hold: only the first alert exists",
    ).toBe(0);
    await expectStillHeld(held, "young hold");
  });
});

describe("legend-rdg29 another tenant", () => {
  it("1191-b-07 each tenant's poller works its own holds: A's poll neither asks about nor alerts for B's hold and vice versa; B's back-off is its own", async () => {
    const heldA = await heldBill();
    const billB = await h.other.paidBill(BILL_IDR);
    const holdB = await h.other.seedHold(
      billB.tenantId,
      billB.intentId,
      OWN_FAILED,
      BILL_IDR,
      billB.providerRef,
    );
    const at = new Date();
    const setBSchedule = async (ageMs: number, gapMs: number) => {
      await h.owner.query(
        "UPDATE refund_recon_holds SET flagged_at = $2 WHERE tenant_id = $1 AND id = $3",
        [billB.tenantId, new Date(at.getTime() - ageMs), holdB],
      );
      await h.owner.query(
        `UPDATE payment_intents SET gateway_polled_at = $2, gateway_poll_lease_until = NULL
          WHERE tenant_id = $1 AND id = $3`,
        [billB.tenantId, new Date(at.getTime() - gapMs), billB.intentId],
      );
    };
    const bNotificationsBefore = await h.other.notificationCount(
      billB.tenantId,
    );

    // A is young and due; B is 3 days old and looked at 30 minutes ago (backed off).
    await schedule(heldA, at, 10 * MINUTE, 2 * MINUTE);
    await setBSchedule(3 * DAY, 30 * MINUTE);
    const bAsksBefore = lookupsOf(billB.providerRef);
    expect(
      await pollAndCount(heldA.code, at),
      "A's poll asks about A's young hold",
    ).toBeGreaterThanOrEqual(1);
    expect(
      lookupsOf(billB.providerRef),
      "A's poll never asks about B's bill",
    ).toBe(bAsksBefore);

    // B's poll: B's own back-off applies (30 minutes < the 3 day schedule), A's bill is not asked.
    const aAsksBefore = lookupsOf(heldA.code.providerRef);
    await schedule(heldA, at, 10 * MINUTE, 2 * MINUTE);
    await h.other.poll(billB.tenantId, at).catch(() => null);
    expect(
      lookupsOf(billB.providerRef),
      "B: a 3 day old hold looked at 30 minutes ago is backed off",
    ).toBe(bAsksBefore);
    expect(
      lookupsOf(heldA.code.providerRef),
      "B's poll never asks about A's bill",
    ).toBe(aAsksBefore);

    // B is due after 3 hours.
    await setBSchedule(3 * DAY, 3 * HOUR);
    await h.other.poll(billB.tenantId, at).catch(() => null);
    expect(
      lookupsOf(billB.providerRef),
      "B: due after 3 hours",
    ).toBeGreaterThan(bAsksBefore);
    expect(lookupsOf(heldA.code.providerRef), "still never A's bill").toBe(
      aAsksBefore,
    );

    // Nobody closes anybody's hold, and A's polls leave B's notifications alone.
    const holdsB = await h.other.holds(billB.tenantId, billB.intentId);
    expect(holdsB).toHaveLength(1);
    expect(holdsB[0]!.resolved_at, "B's hold stays open").toBeNull();
    expect(
      await h.other.notificationCount(billB.tenantId),
      "A's activity sent B nothing",
    ).toBe(bNotificationsBefore);
    await expectStillHeld(heldA, "tenant A");
  });
});
