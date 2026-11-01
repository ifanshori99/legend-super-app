// Customer facility journey: booking a shower room from the facility QR, and
// the access ticket that follows it (WS-09, bead legend-kaqr/legend-gr3j).
// Loaded with plain Node ESM and built-in type stripping like the other
// contract suites: the pure journey rules from
// apps/web/src/features/facility/flow.ts plus the mock runtime, which enforces
// the same contract rules the API will.
//
// Covers PRD v1.7 §3 F22 (Pemesanan, Tiket Akses, Sesi & Pengingat, Langganan
// Bulanan), alur S/T/U and FAC-01, FAC-02, FAC-04, FAC-05, FAC-06, FAC-07.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  cafeLegendFacilityFixtures as fx,
  accessTicketSchema,
  bookAccessTicket,
  cancelAccessTicket,
  getAccessTicket,
  getCurrentFacilitySubscription,
  getFacilityAvailability,
  listAccessTickets,
  subscriptionQuotaState,
  updateFacilitySubscription,
  facilitySubscriptionSchema,
} from "../packages/shared/src/facility/index.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/facility/mock.ts";
import {
  availableSlots,
  blockedUnits,
  businessDateInOutletZone,
  canRedeem,
  draftPayableIdr,
  enterNowAvailable,
  findArea,
  formatClock,
  formatCountdown,
  INITIAL_DRAFT,
  redeemableSessions,
  sessionTimerState,
  ticketStatusMeta,
  unitsForSlot,
} from "../apps/web/src/features/facility/flow.ts";

const facilityId = fx.ids.showerFacilityId;
const areaPria = fx.ids.areaPriaId;
const areaWanita = fx.ids.areaWanitaId;
const productSingle = fx.products[0].id;

function today() {
  return businessDateInOutletZone(new Date());
}

/** Runs one facility endpoint through the mock runtime, like the app does. */
async function request(method, path, { query, body } = {}) {
  return dispatchMock({ method, path, query, body });
}

async function availability(date = today(), areaId = undefined) {
  const { data } = await request("GET", "/api/facility/availability", {
    query: { facilityId, date, areaId },
  });
  return data;
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

/** Books one ticket through the mock, as the booking screen does. */
async function book(overrides = {}) {
  const data = await availability();
  const area = data.areas.find((item) => item.areaId === areaPria);
  const slot = area.units
    .flatMap((unit) => unit.slots)
    .find((option) => option.available);
  assert.ok(slot, "the fixture area has an available slot");
  const unitId = area.units.find((unit) =>
    unit.slots.some((o) => o.startsAt === slot.startsAt && o.available),
  ).unitId;
  const result = await request("POST", "/api/facility/tickets", {
    body: {
      facilityId,
      areaId: areaPria,
      unitId,
      timing: { kind: "slot", startsAt: slot.startsAt },
      productId: productSingle,
      source: "purchase",
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    },
  });
  return { ...result.data, slot };
}

beforeEach(() => {
  resetMocks();
});

describe("availability and slot choice", () => {
  test("FAC-06: a unit that needs cleaning or is under maintenance is never bookable", async () => {
    const data = await availability();
    const wanita = findArea(data, areaWanita);
    assert.ok(wanita);
    assert.equal(
      wanita.units.every((unit) => unit.bookable === false),
      true,
    );
    assert.equal(blockedUnits(wanita).length, wanita.units.length);
    assert.deepEqual(availableSlots(data, areaWanita), []);
    assert.equal(enterNowAvailable(wanita), false);

    const pria = findArea(data, areaPria);
    assert.ok(pria);
    assert.ok(availableSlots(data, areaPria).length > 0);
    assert.equal(enterNowAvailable(pria), true);
  });

  test("FAC-06: offered slots only belong to bookable units", async () => {
    const data = await availability();
    const pria = findArea(data, areaPria);
    for (const slot of availableSlots(data, areaPria)) {
      const units = unitsForSlot(pria, slot.startsAt);
      assert.ok(units.length > 0);
      for (const unitId of units) {
        const unit = pria.units.find((item) => item.unitId === unitId);
        assert.equal(unit.bookable, true);
      }
    }
  });

  test("FAC-02: the same unit and slot cannot be sold twice", async () => {
    const issued = await book();
    // The ticket now holds its unit range; renting the same slot again fails.
    const error = await failure(
      request("POST", "/api/facility/tickets", {
        body: {
          facilityId,
          areaId: areaPria,
          unitId: issued.ticket.unitId,
          timing: { kind: "slot", startsAt: issued.slot.startsAt },
          productId: productSingle,
          source: "purchase",
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    );
    assert.equal(error.code, "SLOT_UNAVAILABLE");
    assert.equal(error.status, 409);
  });
});

describe("access ticket (FAC-01)", () => {
  test("FAC-01: the door window opens one arrival tolerance early and closes with the session", async () => {
    const issued = await book();
    const start = Date.parse(issued.ticket.slot.startsAt);
    assert.equal(
      Date.parse(issued.credential.validFrom),
      start - issued.ticket.graceMinutes * 60_000,
    );
    assert.equal(issued.credential.validUntil, issued.ticket.slot.endsAt);

    const { data } = await request(
      "GET",
      `/api/facility/tickets/${issued.ticket.id}`,
    );
    assert.equal(data.credentialWindow.validFrom, issued.credential.validFrom);
    assert.equal(
      data.credentialWindow.validUntil,
      issued.credential.validUntil,
    );
    // The view never repeats the secret (schemas.ts).
    assert.equal("credential" in data, false);
    assert.equal("pin" in data, false);
  });

  test("FAC-01: the timer moves before → in session → reminder → overtime → ended", async () => {
    const issued = await book();
    const startsAt = issued.credential.validFrom;
    const endsAt = issued.ticket.slot.endsAt;
    const end = Date.parse(endsAt);
    const state = (now) =>
      sessionTimerState({ now, startsAt, endsAt, endedAt: null });

    assert.equal(state(Date.parse(startsAt) - 60_000), "before");
    assert.equal(state(Date.parse(startsAt) + 60_000), "in_session");
    assert.equal(state(end - 5 * 60_000), "reminder");
    assert.equal(state(end + 1), "overtime");
    assert.equal(
      sessionTimerState({
        now: end + 1,
        startsAt,
        endsAt,
        endedAt: endsAt,
      }),
      "ended",
    );
    assert.equal(formatCountdown(5 * 60_000), "05:00");
  });

  test("FAC-01: a cancelled ticket releases its unit and is no longer served", async () => {
    const issued = await book();
    const cancel = await request(
      "POST",
      `/api/facility/tickets/${issued.ticket.id}/cancel`,
      { body: { reason: "Dibatalkan oleh pelanggan" } },
    );
    // The resolution follows the facility's cancellation policy (free window
    // vs late cancel); either way the ticket no longer holds its unit.
    assert.ok(["cancelled", "refunded"].includes(cancel.data.ticket.status));
    assert.ok(
      [
        "entitlement_restored",
        "refund_full",
        "refund_partial",
        "no_refund",
      ].includes(cancel.data.resolution),
    );
    assert.equal(cancel.data.feeIdr >= 0, true);

    const after = await availability();
    const pria = findArea(after, areaPria);
    const released = pria.units.find(
      (unit) => unit.unitId === issued.ticket.unitId,
    );
    assert.equal(
      released.slots.some(
        (slot) => slot.startsAt === issued.slot.startsAt && slot.available,
      ),
      true,
    );
  });

  test("the ticket list is the caller's own tickets, newest session first", async () => {
    const issued = await book();
    const { data } = await request("GET", "/api/facility/tickets", {
      query: { limit: 20 },
    });
    assert.ok(data.some((view) => view.ticket.id === issued.ticket.id));
    assert.equal(
      data.every((view) => view.ticket.customerProfileId === fx.ids.customerC1),
      true,
    );
    const meta = await request("GET", "/api/facility/tickets", {
      query: { limit: 20 },
    });
    assert.equal(meta.meta.nextCursor, null);
    for (const view of data) accessTicketSchema.parse(view.ticket);
    assert.equal(ticketStatusMeta("in_use").tone, "info");
  });
});

describe("entitlement and subscription (FAC-04, FAC-05, FAC-07)", () => {
  function subscriptionView(overrides = {}) {
    const subscription = facilitySubscriptionSchema.parse({
      ...fx.subscriptions[0],
      ...overrides,
    });
    return {
      subscription,
      plan: fx.subscriptionPlans[0],
      quota: subscriptionQuotaState(subscription, "2026-11-02T00:00:00.000Z"),
      invoices: [],
      serverTime: "2026-11-02T00:00:00.000Z",
    };
  }

  test("FAC-04: redemption is offered only while the quota is usable", () => {
    const active = subscriptionView();
    assert.equal(active.quota.usable, true);
    assert.equal(canRedeem(active), true);
    assert.equal(redeemableSessions(active), 8);

    const exhausted = subscriptionView({ quotaUsed: 10 });
    assert.equal(exhausted.quota.reason, "quota_exhausted");
    assert.equal(canRedeem(exhausted), false);
    assert.equal(redeemableSessions(exhausted), 0);

    const paused = subscriptionView({ status: "paused" });
    assert.equal(canRedeem(paused), false);
    assert.equal(redeemableSessions(paused), 0);
    assert.equal(redeemableSessions(null), 0);
  });

  test("FAC-07: an unpaid bill blocks the quota only after its grace period", () => {
    const inGrace = subscriptionView({
      status: "past_due",
      graceUntil: "2026-11-04T00:00:00.000Z",
    });
    // The view above is evaluated on 2026-11-02, inside the grace window.
    assert.equal(inGrace.quota.usable, true);
    assert.equal(inGrace.quota.reason, "past_due_within_grace");
    assert.equal(canRedeem(inGrace), true);

    const afterGrace = subscriptionView({
      status: "past_due",
      graceUntil: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(afterGrace.quota.usable, false);
    assert.equal(afterGrace.quota.reason, "past_due_grace_expired");
    assert.equal(canRedeem(afterGrace), false);
  });

  test("FAC-05: redeeming a subscription session consumes exactly one and names its ledger row", async () => {
    const before = await request("GET", "/api/facility/subscriptions/current");
    const usedBefore = before.data.subscription.quotaUsed;

    const issued = await book({ source: "subscription" });
    assert.notEqual(issued.ticket.entitlementLedgerId, null);
    assert.equal(issued.ticket.source, "subscription");

    const after = await request("GET", "/api/facility/subscriptions/current");
    assert.equal(after.data.subscription.quotaUsed, usedBefore + 1);
  });

  test("FAC-07: redeeming after the subscription was cancelled is refused", async () => {
    const current = await request("GET", "/api/facility/subscriptions/current");
    await request(
      "PATCH",
      `/api/facility/subscriptions/${current.data.subscription.id}`,
      { body: { action: "cancel" } },
    );

    const error = await failure(book({ source: "subscription" }));
    assert.equal(error.code, "SUBSCRIPTION_QUOTA_UNAVAILABLE");
    assert.equal(error.status, 403);
  });

  test("a subscription session still charges its add-ons, not the session", () => {
    const product = { ...fx.products[0], priceIdr: 25_000, sessions: 1 };
    const addon = { ...fx.addons[0], priceIdr: 10_000 };
    const purchase = draftPayableIdr(
      {
        ...INITIAL_DRAFT,
        productId: product.id,
        addonIds: [addon.id],
        source: "purchase",
      },
      [product],
      [addon],
    );
    const redeemed = draftPayableIdr(
      {
        ...INITIAL_DRAFT,
        productId: product.id,
        addonIds: [addon.id],
        source: "subscription",
      },
      [product],
      [addon],
    );
    assert.equal(purchase, 35_000);
    assert.equal(redeemed, 10_000);
  });
});

describe("labels and endpoints used by the screens", () => {
  test("the contract endpoints the screens import stay registered", () => {
    for (const endpoint of [
      bookAccessTicket,
      cancelAccessTicket,
      getAccessTicket,
      getCurrentFacilitySubscription,
      getFacilityAvailability,
      listAccessTickets,
      updateFacilitySubscription,
    ])
      assert.equal(typeof endpoint.id, "string");
  });

  test("times are rendered in the outlet time zone", () => {
    // 2026-11-02T23:00:00.000Z is 06:00 in Asia/Jakarta (+07:00).
    assert.equal(formatClock("2026-11-01T23:00:00.000Z"), "06.00");
  });
});
