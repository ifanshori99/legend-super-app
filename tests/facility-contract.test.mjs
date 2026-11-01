// WS-09 facility & WFC contract tests (bead legend-lmmn; PRD v1.7 §3 F22/F23/F39,
// §6 K, FAC-01..FAC-14). Every test name carries the acceptance ID it proves.
// Run with: pnpm test (root node:test suite, no database needed).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as facility from "../packages/shared/src/facility/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import { matchEndpointPath } from "../packages/shared/src/api/index.ts";

const f = facility.cafeLegendFacilityFixtures;
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const shower = f.facilities[0];
const ticketA = f.tickets[0];
const ticketB = f.tickets[1];

test("WS-09 fixtures parse and cover the whole facility contract", () => {
  facility.facilityFixtureSchema.parse(f);
  assert.ok(f.facilities.length >= 2);
  assert.ok(f.tickets.length >= 5);
  assert.equal(
    new Set(f.tickets.map((ticket) => ticket.id)).size,
    f.tickets.length,
  );
  for (const ticket of f.tickets) {
    assert.equal(ticket.tenantId, f.tenant.id);
    assert.equal(ticket.outletId, f.outlet.id);
  }
  // Money is whole rupiah (D-CORE-2), never a string or a fraction.
  assert.equal(Number.isInteger(f.tickets[2].overtimeFeeIdr), true);
  assert.equal(f.tickets[2].overtimeFeeIdr, 10_000);
});

test("FAC-09 Cafe Legend has 4 booths in 2 separate areas, 20-minute sessions, 10-minute cleaning, 06:00-10:00", () => {
  assert.equal(shower.sessionMinutes, 20);
  assert.equal(shower.cleaningMinutes, 10);
  assert.equal(shower.arrivalGraceMinutes, 10);
  assert.deepEqual(shower.operatingHours, [
    {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      opensAt: "06:00",
      closesAt: "10:00",
    },
  ]);
  const areas = f.areas.filter((area) => area.facilityId === shower.id);
  const units = f.units.filter((unit) => unit.facilityId === shower.id);
  assert.equal(areas.length, 2);
  assert.equal(units.length, 4);
  assert.equal(units.filter((unit) => unit.areaId === areas[0].id).length, 2);
  assert.equal(units.filter((unit) => unit.areaId === areas[1].id).length, 2);
});

test("FAC-09 the customer profile stores no gender; the area lives on the ticket only", () => {
  // Nothing in the fixture bundle names a gender at all.
  assert.equal(
    /gender|jenis[ _]?kelamin|"sex"/i.test(JSON.stringify(f)),
    false,
  );
  // The ticket schema rejects a gender field rather than ignoring it.
  assert.equal(
    facility.accessTicketSchema.safeParse({ ...ticketA, gender: "male" })
      .success,
    false,
  );
  // Every ticket names the area it was booked for, and that area owns its unit.
  for (const ticket of f.tickets) {
    const unit = f.units.find((candidate) => candidate.id === ticket.unitId);
    assert.equal(unit.areaId, ticket.areaId);
  }
});

test("FAC-02 slot overlap includes the cleaning buffer and is half-open at the boundary", () => {
  const first = ticketA.slot; // 06:00-06:20 WIB, cleaning until 06:30
  assert.equal(
    facility.slotRangeLiteral(first),
    '["2026-11-01T23:00:00.000Z","2026-11-01T23:30:00.000Z")',
  );
  assert.equal(facility.slotOccupiedRange(first).bounds, "[)");

  const insideSession = facility.slotFromStart("2026-11-01T23:15:00.000Z", {
    sessionMinutes: 20,
    cleaningMinutes: 10,
  });
  const insideCleaning = facility.slotFromStart("2026-11-01T23:20:00.000Z", {
    sessionMinutes: 20,
    cleaningMinutes: 10,
  });
  const backToBack = facility.slotFromStart("2026-11-01T23:30:00.000Z", {
    sessionMinutes: 20,
    cleaningMinutes: 10,
  });
  assert.equal(facility.slotsOverlap(first, insideSession), true);
  assert.equal(facility.slotsOverlap(first, insideCleaning), true);
  assert.equal(facility.slotsOverlap(first, backToBack), false);

  assert.throws(
    () => facility.assertNoSlotOverlap(insideCleaning, [first]),
    /Slot ini sudah terisi/,
  );
  assert.equal(
    facility.assertNoSlotOverlap(backToBack, [first, first]),
    undefined,
  );
});

test("FAC-02 a cancelled, refunded or no-show ticket releases its unit while an issued one holds it", () => {
  for (const status of ["pending_payment", "issued", "in_use", "completed"])
    assert.equal(facility.ticketHoldsSlot(status), true, status);
  for (const status of ["cancelled", "refunded", "no_show"])
    assert.equal(facility.ticketHoldsSlot(status), false, status);
});

test("FAC-01 a ticket opens exactly one unit inside its own session window and re-entry does not restart it", () => {
  const window = facility.ticketCredentialWindow(ticketA);
  assert.deepEqual(window, {
    validFrom: "2026-11-01T22:50:00.000Z",
    validUntil: "2026-11-01T23:20:00.000Z",
  });
  // Before the arrival tolerance, inside it, inside the session, at the end.
  assert.equal(
    facility.isTicketUsableAt(ticketA, "2026-11-01T22:49:59.000Z"),
    false,
  );
  assert.equal(
    facility.isTicketUsableAt(ticketA, "2026-11-01T22:50:00.000Z"),
    true,
  );
  assert.equal(
    facility.isTicketUsableAt(ticketA, "2026-11-01T23:19:59.000Z"),
    true,
  );
  assert.equal(
    facility.isTicketUsableAt(ticketA, "2026-11-01T23:20:00.000Z"),
    false,
  );
  // The same ticket cannot be used for the previous day's session.
  assert.equal(
    facility.isTicketUsableAt(ticketA, "2026-10-31T23:05:00.000Z"),
    false,
  );
  assert.throws(
    () => facility.openTicketSession(ticketA, "2026-10-31T23:05:00.000Z"),
    /di luar jendela sesi/,
  );

  const opened = facility.openTicketSession(
    ticketA,
    "2026-11-01T23:01:00.000Z",
  );
  assert.equal(opened.status, "in_use");
  assert.equal(opened.firstOpenedAt, "2026-11-01T23:01:00.000Z");
  const reopened = facility.openTicketSession(
    opened,
    "2026-11-01T23:10:00.000Z",
  );
  assert.equal(reopened.firstOpenedAt, "2026-11-01T23:01:00.000Z");
  assert.equal(reopened.unitId, opened.unitId);
});

test("FAC-01 the door credential is bound to the ticket's unit and area and stores only hashes", () => {
  const credential = f.credentials[0];
  assert.equal(credential.ticketId, ticketA.id);
  assert.equal(credential.unitId, ticketA.unitId);
  assert.equal(credential.areaId, ticketA.areaId);
  assert.match(credential.pin, /^\d{6}$/);
  // The server records SHA-256 digests, never the plaintext PIN or QR token,
  // and a client ticket can never carry a digest (a 6-digit PIN would be
  // brute-forced from its hash).
  const digestRow = f.credentialDigests.find(
    (row) => row.ticketId === ticketA.id,
  );
  assert.match(digestRow.qrHash, /^[0-9a-f]{64}$/);
  assert.match(digestRow.pinHash, /^[0-9a-f]{64}$/);
  assert.equal(
    facility.accessTicketSchema.safeParse({
      ...ticketA,
      pinHash: digestRow.pinHash,
    }).success,
    false,
  );
  assert.equal("qrHash" in ticketA, false);
  assert.equal("pinHash" in ticketA, false);
});

test("FAC-03 a pushed lock credential verifies offline from its own window, hours after issue", () => {
  // Sold at 22:44 for a session that starts 3 h 55 m later: the lock needs no
  // network call at the door, only the window it already stores.
  const credential = facility.lockCredentialSchema.parse({
    ...f.lockCredentials[0],
    id: uid(9961),
    providerRef: "LOCK-P1-0002",
    validFrom: "2026-11-02T02:39:00.000Z",
    validUntil: "2026-11-02T02:59:00.000Z",
    pushedAt: "2026-11-01T22:44:00.000Z",
    status: "pushed",
  });
  // The edge/lock payload round-trips through JSON unchanged (no live object).
  const offline = JSON.parse(JSON.stringify(credential));
  assert.equal(
    facility.isLockCredentialValidAt(offline, "2026-11-02T02:50:00.000Z"),
    true,
  );
  assert.equal(
    facility.isLockCredentialValidAt(offline, "2026-11-02T02:59:00.000Z"),
    false,
  );
  assert.equal(
    facility.isLockCredentialValidAt(
      { ...offline, status: "revoked" },
      "2026-11-02T02:50:00.000Z",
    ),
    false,
  );
  assert.equal(
    facility.isLockCredentialValidAt(
      { ...offline, status: "expired" },
      "2026-11-02T02:50:00.000Z",
    ),
    false,
  );
  // The credential never opens more than the ticket's own door window.
  assert.equal(
    facility.lockCredentialCoversTicket(f.lockCredentials[0], ticketA),
    true,
  );
  assert.equal(
    facility.lockCredentialCoversTicket(f.lockCredentials[1], ticketA),
    false,
  );
  assert.equal(facility.LOCK_CLOCK_SKEW_TOLERANCE_SECONDS <= 300, true);
});

test("FAC-04 an entitlement is issued only after payment and its condition, and a refund cancels it", () => {
  assert.deepEqual(
    facility.entitlementIssueCheck({
      source: "package",
      paid: false,
      conditionsMet: true,
    }),
    { issuable: false, reason: "unpaid" },
  );
  assert.deepEqual(
    facility.entitlementIssueCheck({
      source: "subscription",
      paid: false,
      conditionsMet: true,
    }),
    { issuable: false, reason: "unpaid" },
  );
  assert.deepEqual(
    facility.entitlementIssueCheck({
      source: "tier_benefit",
      paid: false,
      conditionsMet: true,
    }),
    { issuable: true, reason: "ok" },
  );
  assert.deepEqual(
    facility.entitlementIssueCheck({
      source: "min_spend",
      paid: true,
      conditionsMet: false,
    }),
    { issuable: false, reason: "conditions_not_met" },
  );

  const base = {
    id: uid(9971),
    tenantId: f.tenant.id,
    outletId: f.outlet.id,
    facilityId: shower.id,
    customerProfileId: f.ids.customerC4,
    type: "grant",
    sessions: 2,
    sourceType: "package",
    sourceRef: "01JBQ7Z8K3M4N5P6Q7R8S9T0W9",
    accessTicketId: null,
    expiresAt: "2026-11-30T17:00:00.000Z",
    occurredAt: "2026-11-01T02:00:00.000Z",
    actorUserId: null,
    reason: null,
  };
  const grant = facility.entitlementLedgerEntrySchema.parse(base);
  const cancel = facility.entitlementLedgerEntrySchema.parse({
    ...base,
    id: uid(9972),
    type: "cancel",
    occurredAt: "2026-11-01T03:00:00.000Z",
    reason: "Transaksi sumber di-refund",
  });
  assert.equal(
    facility.entitlementBalance([grant], {
      customerProfileId: f.ids.customerC4,
      facilityId: shower.id,
      at: "2026-11-02T00:00:00.000Z",
    }).availableSessions,
    2,
  );
  assert.equal(
    facility.entitlementBalance([grant, cancel], {
      customerProfileId: f.ids.customerC4,
      facilityId: shower.id,
      at: "2026-11-02T00:00:00.000Z",
    }).availableSessions,
    0,
  );
  // The scheduled expiry alone never removes sessions: only the job's `expire`
  // movement does, so an expired-then-redeemed grant cannot go negative.
  assert.equal(
    facility.isGrantExpired(grant, "2026-12-01T00:00:00.000Z"),
    true,
  );
  assert.equal(
    facility.isGrantExpired(grant, "2026-11-02T00:00:00.000Z"),
    false,
  );
});

test("FAC-05 one grant cannot be redeemed twice and one ticket cannot consume two grants", () => {
  const claim = {
    ledgerId: f.ids.ledgerTierGrant,
    ticketId: f.ids.ticketA,
  };
  assert.deepEqual(facility.claimRedemption(claim, []), claim);
  assert.throws(
    () => facility.claimRedemption(claim, [claim]),
    /sudah ditukar/,
  );
  assert.throws(
    () =>
      facility.claimRedemption(
        { ledgerId: f.ids.ledgerTierGrant, ticketId: f.ids.ticketB },
        [claim],
      ),
    /sudah ditukar/,
  );
  assert.throws(
    () =>
      facility.claimRedemption(
        { ledgerId: f.ids.ledgerMinSpendGrant, ticketId: f.ids.ticketA },
        [claim],
      ),
    /sudah ditukar/,
  );

  // A single-session grant is exhausted after one redemption.
  const balance = facility.entitlementBalance(f.entitlementLedger, {
    customerProfileId: f.ids.customerC2,
    facilityId: shower.id,
    at: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(balance.grantedSessions, 1);
  assert.equal(balance.redeemedSessions, 1);
  assert.equal(balance.availableSessions, 0);
  assert.equal(facility.canRedeemEntitlement(balance), false);
  assert.throws(
    () => facility.assertRedemptionAvailable(balance),
    /kuota hak akses/i,
  );

  // FAC-05 at the row level: an entitlement-sourced ticket always names its
  // grant, and a purchase never consumes one.
  assert.equal(
    facility.accessTicketSchema.safeParse({
      ...ticketB,
      entitlementLedgerId: null,
    }).success,
    false,
  );
  assert.equal(
    facility.accessTicketSchema.safeParse({
      ...ticketA,
      entitlementLedgerId: f.ids.ledgerTierGrant,
    }).success,
    false,
  );

  // Legend customer C1 still holds subscription + tier sessions.
  const c1 = facility.entitlementBalance(f.entitlementLedger, {
    customerProfileId: f.ids.customerC1,
    facilityId: shower.id,
    at: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(c1.availableSessions, 10);
});

test("FAC-06 a unit that needs cleaning or is under maintenance cannot be booked", () => {
  for (const status of ["in_use", "needs_cleaning", "cleaning", "maintenance"])
    assert.equal(facility.isUnitBookable(status), false);
  assert.equal(facility.isUnitBookable("available"), true);
  assert.throws(
    () => facility.assertUnitBookable("needs_cleaning"),
    /belum bersih atau sedang dalam perawatan/,
  );

  // Maintenance release requires a cleaning cycle before the next booking.
  assert.equal(
    facility.transitionUnit("maintenance", "release_maintenance"),
    "needs_cleaning",
  );
  assert.equal(
    facility.transitionUnit("needs_cleaning", "start_cleaning"),
    "cleaning",
  );
  assert.equal(
    facility.transitionUnit("cleaning", "complete_cleaning"),
    "available",
  );
  assert.throws(
    () => facility.transitionUnit("needs_cleaning", "complete_cleaning"),
    /tidak dapat menjalani/,
  );

  // The availability fixture mirrors it: dirty and maintenance units offer no slot.
  const dirty = f.availability.areas[1].units[0];
  const maintenance = f.availability.areas[1].units[1];
  for (const unit of [dirty, maintenance]) {
    assert.equal(unit.bookable, false);
    assert.equal(
      unit.slots.every((slot) => slot.available === false),
      true,
    );
  }
  assert.equal(f.availability.areas[0].units[0].slots[0].available, false);
  assert.equal(f.availability.areas[0].units[0].slots[1].available, true);
});

test("FAC-06 a cleaning cycle completes only with a started task and every checklist item done", () => {
  const inProgress = f.cleaningTasks[0];
  assert.equal(facility.cleaningTaskStatus(inProgress), "in_progress");
  assert.throws(
    () =>
      facility.completeCleaningCycle(inProgress, "2026-10-31T23:40:00.000Z", {
        checklist: inProgress.checklist,
      }),
    /checklist kebersihan/,
  );
  const allDone = facility.cleaningChecklistSchema.parse(
    inProgress.checklist.map((item) => ({ ...item, done: true })),
  );
  const completed = facility.completeCleaningCycle(
    inProgress,
    "2026-10-31T23:40:00.000Z",
    { checklist: allDone },
  );
  assert.equal(completed.completedAt, "2026-10-31T23:40:00.000Z");
  assert.equal(facility.cleaningTaskStatus(completed), "done");

  const pending = facility.cleaningTaskSchema.parse({
    ...inProgress,
    id: uid(9962),
    startedAt: null,
    completedAt: null,
    checklist: allDone,
  });
  assert.throws(
    () =>
      facility.completeCleaningCycle(pending, "2026-10-31T23:40:00.000Z", {
        checklist: allDone,
      }),
    /Mulai tugas kebersihan/,
  );
  const started = facility.startCleaningCycle(
    pending,
    "2026-10-31T23:38:00.000Z",
    f.ids.staffUserId,
  );
  assert.equal(facility.cleaningTaskStatus(started), "in_progress");
});

test("FAC-07 a past-due subscription keeps its quota inside the grace period and loses it after", () => {
  const pastDue = f.subscriptions[1];
  const inside = facility.subscriptionQuotaState(
    pastDue,
    "2026-11-02T00:00:00.000Z",
  );
  assert.equal(inside.usable, true);
  assert.equal(inside.reason, "past_due_within_grace");
  assert.equal(inside.remaining, 15);

  const after = facility.subscriptionQuotaState(
    pastDue,
    "2026-11-05T00:00:00.000Z",
  );
  assert.equal(after.usable, false);
  assert.equal(after.reason, "past_due_grace_expired");

  const paid = facility.subscriptionQuotaState(
    { ...pastDue, status: "active", graceUntil: null },
    "2026-11-05T00:00:00.000Z",
  );
  assert.equal(paid.usable, true);
  assert.equal(paid.reason, "ok");
  assert.equal(
    facility.transitionSubscription("past_due", "payment_paid"),
    "active",
  );

  const exhausted = facility.subscriptionQuotaState(
    { ...f.subscriptions[0], quotaUsed: 10 },
    "2026-11-02T00:00:00.000Z",
  );
  assert.equal(exhausted.usable, false);
  assert.equal(exhausted.reason, "quota_exhausted");
  assert.throws(
    () => facility.transitionSubscription("cancelled", "payment_paid"),
    /tidak dapat menjalani/,
  );
});

test("FAC-08 the emergency button targets a five-second response and records how fast it was answered", () => {
  assert.equal(facility.PANIC_RESPONSE_TARGET_SECONDS, 5);
  assert.equal(
    facility.panicResponseDeadline("2026-11-01T23:05:00.000Z"),
    "2026-11-01T23:05:05.000Z",
  );
  assert.equal(facility.isPanicResponseOnTime(f.incidents[0]), true);
  assert.equal(
    facility.isPanicResponseOnTime({
      ...f.incidents[0],
      respondedAt: "2026-11-01T23:05:06.000Z",
    }),
    false,
  );
  assert.equal(facility.isPanicResponseOnTime(f.incidents[1]), false);
  assert.throws(
    () =>
      facility.respondToFacilityIncident(f.incidents[0], {
        respondedBy: f.ids.staffUserId,
        respondedAt: "2026-11-01T23:06:00.000Z",
        resolution: "Sudah ditangani",
      }),
    /sudah ditangani/,
  );
});

test("FAC-10 the breakfast order fires a configurable offset before the session ends", () => {
  const linked = f.linkedOrders[0];
  const ticket = f.tickets.find((row) => row.id === linked.accessTicketId);
  assert.equal(linked.fireOffsetMinutes, 5);
  assert.equal(
    Date.parse(linked.fireAt),
    Date.parse(ticket.slot.endsAt) - 5 * 60_000,
  );
  assert.equal(facility.linkedOrderFireAt(ticket, 5), linked.fireAt);
  // An extension moves the fire time with the session end.
  const extended = {
    ...ticket,
    slot: { ...ticket.slot, endsAt: "2026-11-01T23:35:00.000Z" },
  };
  assert.equal(
    facility.linkedOrderFireAt(extended, 5),
    "2026-11-01T23:30:00.000Z",
  );
});

test("FAC-12 every full Rp30.000 of paid spend adds an hour and an account may hold 2 Wi-Fi devices", () => {
  const policy = f.wifiPolicies[0];
  assert.deepEqual(facility.WIFI_POLICY_DEFAULTS, {
    freeMinutes: 120,
    peakFreeMinutes: 60,
    spendPerExtraHourIdr: 30_000,
    extraMinutes: 60,
    maxDevices: 2,
  });
  assert.equal(facility.wifiExtraMinutesForSpend(policy, 29_999), 0);
  assert.equal(facility.wifiExtraMinutesForSpend(policy, 30_000), 60);
  assert.equal(facility.wifiExtraMinutesForSpend(policy, 89_999), 120);
  assert.equal(facility.wifiExtraMinutesForSpend(policy, 90_000), 180);

  assert.equal(
    facility.wifiQuotaMinutes(policy, {
      isPeak: false,
      sameDaySpendIdr: 90_000,
    }),
    300,
  );
  assert.equal(
    facility.wifiQuotaMinutes(policy, {
      isPeak: true,
      sameDaySpendIdr: 90_000,
    }),
    240,
  );
  assert.equal(
    facility.wifiQuotaMinutes(policy, {
      isPeak: false,
      tierKey: "gold",
      sameDaySpendIdr: 0,
    }),
    180,
  );

  assert.equal(facility.assertWifiDeviceAllowed(1, policy), undefined);
  assert.throws(
    () => facility.assertWifiDeviceAllowed(2, policy),
    /mencapai batas/,
  );
});

test("FAC-13 a spent quota throttles to the base speed and never disconnects", () => {
  assert.deepEqual(facility.wifiSpeedTierSchema.options, ["full", "base"]);
  assert.equal(facility.wifiSpeedTier(119, 120), "full");
  assert.equal(facility.wifiSpeedTier(120, 120), "base");
  assert.equal(facility.wifiSpeedTier(5000, 120), "base");
  assert.equal(
    facility.wifiRemainingMinutes({ quotaMinutes: 120, usedMinutes: 135 }),
    0,
  );
  const throttled = f.wifiSessions[1];
  assert.equal(throttled.speedTier, "base");
  assert.equal(throttled.endedAt, null);
});

test("FAC-14 peak-hour rules come from the policy row in the outlet time zone and change without a redeploy", () => {
  const policy = f.wifiPolicies[0];
  // Noon and 20:00 on the fixture days, 10:00 outside the peak windows.
  assert.equal(
    facility.isPeakAt(policy, "2026-11-02T05:00:00.000Z", "Asia/Jakarta"),
    true,
  );
  assert.equal(
    facility.isPeakAt(policy, "2026-11-02T03:00:00.000Z", "Asia/Jakarta"),
    false,
  );
  assert.equal(
    facility.isPeakAt(policy, "2026-11-01T13:00:00.000Z", "Asia/Jakarta"),
    true,
  );
  assert.deepEqual(
    facility.wallClockAt("2026-11-02T05:00:00.000Z", "Asia/Jakarta"),
    {
      dayOfWeek: 1,
      minutesOfDay: 720,
    },
  );

  // The admin panel edits the row; the same pure function sees it immediately.
  const edited = {
    ...policy,
    peakSchedule: [{ daysOfWeek: [1], startsAt: "09:00", endsAt: "10:00" }],
  };
  assert.equal(
    facility.isPeakAt(edited, "2026-11-02T02:30:00.000Z", "Asia/Jakarta"),
    true,
  );
});

test("PRD F22 overtime is charged per started block after the tolerance", () => {
  const policy = shower.overtimePolicy;
  const onTime = facility.computeOvertime(policy, {
    scheduledEndsAt: ticketA.slot.endsAt,
    endedAt: "2026-11-01T23:24:00.000Z",
  });
  assert.equal(onTime.overtimeMinutes, 4);
  assert.equal(onTime.feeIdr, 0);

  const eightLate = facility.computeOvertime(policy, {
    scheduledEndsAt: ticketA.slot.endsAt,
    endedAt: "2026-11-01T23:28:00.000Z",
  });
  assert.deepEqual(eightLate, {
    overtimeMinutes: 8,
    chargeableMinutes: 3,
    blocks: 1,
    feeIdr: 10_000,
  });

  const veryLate = facility.computeOvertime(policy, {
    scheduledEndsAt: ticketA.slot.endsAt,
    endedAt: "2026-11-01T23:45:00.000Z",
  });
  assert.equal(veryLate.blocks, 2);
  assert.equal(veryLate.feeIdr, 20_000);

  const ended = facility.endTicketSession(
    ticketB,
    "2026-11-01T23:31:00.000Z",
    policy,
  );
  assert.equal(ended.status, "completed");
  assert.equal(ended.overtimeFeeIdr, 10_000);
  // A retried edge event does not charge twice.
  assert.equal(
    facility.endTicketSession(ended, "2026-11-01T23:50:00.000Z", policy),
    ended,
  );
});

test("PRD F22 cancellation resolves per policy before the slot, and never after it starts", () => {
  const policy = shower.cancellationPolicy;
  assert.deepEqual(
    facility.cancellationOutcome(policy, ticketA, "2026-11-01T21:00:00.000Z"),
    { resolution: "refund_full", feeIdr: 0 },
  );
  assert.deepEqual(
    facility.cancellationOutcome(policy, ticketA, "2026-11-01T22:30:00.000Z"),
    { resolution: "no_refund", feeIdr: 0 },
  );
  const entitlementTicket = { ...ticketB, status: "issued" };
  assert.equal(
    facility.cancellationOutcome(
      policy,
      entitlementTicket,
      "2026-11-01T21:00:00.000Z",
    ).resolution,
    "entitlement_restored",
  );
  assert.throws(
    () =>
      facility.cancellationOutcome(policy, ticketB, "2026-11-01T23:05:00.000Z"),
    /belum dipakai|sudah dimulai/,
  );
  // Nothing was paid on a pending-payment ticket, so cancelling it refunds nothing.
  assert.deepEqual(
    facility.cancellationOutcome(
      policy,
      { ...ticketA, status: "pending_payment" },
      "2026-11-01T21:00:00.000Z",
    ),
    { resolution: "no_refund", feeIdr: 0 },
  );
});

test("PRD F22 operating hours bound the session, and the wait estimate uses the free units", () => {
  assert.equal(
    facility.isWithinOperatingHours(
      shower.operatingHours,
      "2026-11-02T02:59:00.000Z",
      "Asia/Jakarta",
    ),
    true,
  );
  assert.equal(
    facility.isWithinOperatingHours(
      shower.operatingHours,
      "2026-11-02T03:00:00.000Z",
      "Asia/Jakarta",
    ),
    false,
  );
  const fits = facility.slotFromStart("2026-11-02T02:40:00.000Z", {
    sessionMinutes: 20,
    cleaningMinutes: 10,
  });
  const overruns = facility.slotFromStart("2026-11-02T02:50:00.000Z", {
    sessionMinutes: 20,
    cleaningMinutes: 10,
  });
  assert.equal(
    facility.slotFitsOperatingHours(
      fits,
      shower.operatingHours,
      "Asia/Jakarta",
    ),
    true,
  );
  assert.equal(
    facility.slotFitsOperatingHours(
      overruns,
      shower.operatingHours,
      "Asia/Jakarta",
    ),
    false,
  );
  assert.equal(facility.estimateWaitMinutes(2, 20, 1), 40);
  assert.equal(facility.estimateWaitMinutes(0, 20, 1), 0);
  assert.equal(f.availability.waitEstimate.queueLength, 2);
  assert.equal(
    facility.sessionsOnBusinessDate(f.tickets, {
      businessDate: "2026-11-02",
      customerProfileId: f.ids.customerC1,
      timeZone: "Asia/Jakarta",
    }),
    2,
  );
});

test("WS-09 events are exactly the catalogued WS-09 names and every envelope validates", () => {
  const catalogued = events.eventCatalog
    .filter((entry) => entry.workstream === "WS-09")
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(catalogued, [...facility.FACILITY_EVENT_NAMES].sort());
  assert.deepEqual(catalogued, [
    "access_event.recorded",
    "access_ticket.issued",
    "access_ticket.redeemed",
    "cleaning_task.created",
    "facility_entitlement.expired",
    "facility_entitlement.issued",
    "facility_entitlement.revoked",
    "facility_incident.raised",
    "facility_session.ended",
    "facility_session.started",
    "subscription.billed",
    "wifi_quota.updated",
  ]);

  for (const definition of facility.FACILITY_EVENT_DEFINITIONS) {
    const payload = f.eventSamples[definition.name];
    assert.ok(payload, `missing sample for ${definition.name}`);
    const envelope = {
      id: "01JBQ7Z8K3M4N5P6Q7R8S9T0YZ",
      tenantId: f.tenant.id,
      outletId: f.outlet.id,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.name.split(".")[0],
      aggregateId: "01JBQ7Z8K3M4N5P6Q7R8S9T0YY",
      sequence: 1,
      occurredAt: "2026-11-01T23:00:00.000Z",
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `ws09-${definition.name}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload,
    };
    assert.equal(
      definition.envelopeSchema.safeParse(envelope).success,
      true,
      definition.name,
    );
    // Secrets never travel in an event payload.
    for (const key of Object.keys(payload))
      assert.equal(
        /pin|qr|credential|fingerprint|devicehash/i.test(key),
        false,
        `${definition.name}.${key}`,
      );
  }
});

test("the facility contract exports one subpath, well-formed endpoints and no runtime-only APIs", () => {
  const pkg = JSON.parse(
    readFileSync(
      new URL("../packages/shared/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pkg.exports["./facility"], "./src/facility/index.ts");

  assert.ok(facility.facilityEndpoints.length >= 30);
  const ids = facility.facilityEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of facility.facilityEndpoints) {
    assert.equal(Object.isFrozen(endpoint), true);
    assert.equal(endpoint.path.startsWith("/api/"), true, endpoint.id);
  }
  assert.deepEqual(
    matchEndpointPath(
      facility.getAccessTicket.path,
      `/api/facility/tickets/${f.ids.ticketA}`,
    ),
    { ticketId: f.ids.ticketA },
  );

  // Browser-safe and Node-safe: the files run in the API, the edge and the web app.
  const directory = new URL(
    "../packages/shared/src/facility/",
    import.meta.url,
  );
  const files = readdirSync(directory).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = readFileSync(new URL(file, directory), "utf8");
    assert.equal(/from\s+["']node:/.test(source), false, file);
    assert.equal(/\brequire\(/.test(source), false, file);
    assert.equal(/\bBuffer\./.test(source), false, file);
    assert.equal(/\bprocess\.env/.test(source), false, file);
    assert.equal(/\bdocument\.\w+\(/.test(source), false, file);
    assert.equal(/\bwindow\.\w+\(/.test(source), false, file);
    // Native Node ESM loads these files directly: relative imports carry .ts.
    assert.equal(
      /from\s+["']\.\.?\/[^"']*(?<!\.ts)["']/.test(source),
      false,
      file,
    );
  }
});
