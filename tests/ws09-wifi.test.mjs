// WS-09 guest Wi-Fi portal (bead legend-g9r3; PRD v1.7 §3 Kelompok C "Wi-Fi
// Tamu & WFC", §4 Alur X, FAC-11/FAC-12/FAC-13). Runs with the root node:test
// suite, no database: it loads the shared facility contract, the web app's
// mock runtime and the portal's own helpers with Node type stripping.
//
// The portal screen itself is exercised end-to-end in e2e/legend-g9r3.mock.spec.ts;
// this file proves the data layer and the derivations the screen renders.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as facility from "../packages/shared/src/facility/index.ts";
import { createTranslator } from "../packages/shared/src/i18n/index.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import { wifiMockControl } from "../apps/web/src/features/ws09-wifi/mock.ts";
import * as portal from "../apps/web/src/features/ws09-wifi/state.ts";

const t = createTranslator();
const fixtures = facility.cafeLegendFacilityFixtures;
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wfcZoneId = uid(9401);
const wfcFacilityId = uid(9002);
const showerFacilityId = uid(9001);

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}

async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}

function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

afterEach(resetMocks);

describe("guest Wi-Fi portal data (contract fixtures)", () => {
  test("the zone policy, the running session and the WFC plans come from the contract fixtures", async () => {
    const policy = await get("/api/wifi/policy", { zoneId: wfcZoneId });
    assert.equal(policy.data.zoneId, wfcZoneId);
    assert.equal(policy.data.freeMinutes, 120);

    const current = await get("/api/wifi/sessions/current");
    assert.equal(current.data.remainingMinutes, 255);
    assert.equal(current.data.session.speedTier, "full");

    const plans = await get("/api/facility/subscription-plans", {
      facilityId: wfcFacilityId,
    });
    assert.equal(plans.data.plans.length, 1);
    assert.equal(plans.data.plans[0].priceIdr, 400_000);
  });

  test("an unknown zone has no policy to serve", async () => {
    const error = await failure(
      get("/api/wifi/policy", { zoneId: showerFacilityId }),
    );
    assert.equal(error.status, 404);
  });

  test("?mock=empty reports no running session so the connect screen can be reviewed", async () => {
    setScenario("empty");
    const current = await get("/api/wifi/sessions/current");
    assert.equal(current.data, null);
  });
});

describe("Wi-Fi quota engine (FAC-12, FAC-13)", () => {
  test("FAC-12 the allowance adds one hour per full Rp30.000 of paid spend", async () => {
    // The seed already carries Rp90.000 (2 free hours + 3 hours).
    const before = await get("/api/wifi/sessions/current");
    assert.equal(before.data.session.quotaMinutes, 300);

    // A paid order lands on the account; the refresh request itself is empty.
    wifiMockControl.pay(120_000);
    const paid = await post("/api/wifi/sessions/current/refresh", {});
    // 4 full Rp30.000 steps → 4 hours on top of the 2 free hours.
    assert.equal(paid.data.session.quotaMinutes, 360);
    assert.equal(paid.data.remainingMinutes, 315);
  });

  test("FAC-12 the refresh endpoint rejects a client-supplied same-day spend", async () => {
    const error = await failure(
      post("/api/wifi/sessions/current/refresh", {
        sameDaySpendIdr: 20_000_000,
      }),
    );
    assert.equal(error.status, 400);
    assert.equal(error.code, "VALIDATION_ERROR");
    // The rejected body granted nothing: the quota stays on server-side spend.
    const current = await get("/api/wifi/sessions/current");
    assert.equal(current.data.session.quotaMinutes, 300);
  });

  test("FAC-12 the allowance never exceeds one day", async () => {
    wifiMockControl.pay(20_000_000);
    const paid = await post("/api/wifi/sessions/current/refresh", {});
    assert.equal(
      paid.data.session.quotaMinutes,
      facility.WIFI_MAX_DAILY_MINUTES,
    );
  });

  test("FAC-12 a second device is allowed up to the policy limit, a third is refused", async () => {
    const first = await post("/api/wifi/sessions", {
      zoneId: wfcZoneId,
      deviceFingerprint: "second-device-fingerprint",
    });
    assert.equal(first.data.session.quotaMinutes, 300);

    const error = await failure(
      post("/api/wifi/sessions", {
        zoneId: wfcZoneId,
        deviceFingerprint: "third-device-fingerprint",
      }),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "WIFI_DEVICE_LIMIT");
  });

  test("FAC-13 a spent quota drops to the base speed and the session stays connected", async () => {
    wifiMockControl.consume(300);
    const spent = await get("/api/wifi/sessions/current");
    assert.equal(spent.data.remainingMinutes, 0);
    assert.equal(spent.data.session.speedTier, "base");
    // FAC-13: throttled is the terminal state — never disconnected.
    assert.equal(spent.data.session.endedAt, null);
  });

  test("FAC-13 paying again restores the full speed for the rest of the day", async () => {
    wifiMockControl.consume(300);
    wifiMockControl.pay(210_000);
    const paid = await post("/api/wifi/sessions/current/refresh", {});
    // 7 full steps → 7 hours + 2 free hours.
    assert.equal(paid.data.session.quotaMinutes, 540);
    assert.equal(paid.data.session.speedTier, "full");
    assert.equal(paid.data.remainingMinutes, 240);
  });
});

describe("portal derivations (UI text and links)", () => {
  test("PRD Alur X the reminder appears at 15 minutes left and never at zero", () => {
    assert.equal(portal.shouldRemind(15), true);
    assert.equal(portal.shouldRemind(1), true);
    assert.equal(portal.shouldRemind(16), false);
    // Zero is the spent state, which has its own message (FAC-13).
    assert.equal(portal.shouldRemind(0), false);
  });

  test("the quota meter reads as hours and minutes", () => {
    assert.equal(portal.formatMinutes(255, t), "4 jam 15 menit");
    assert.equal(portal.formatMinutes(120, t), "2 jam");
    assert.equal(portal.formatMinutes(45, t), "45 menit");
  });

  test("peak windows group their days instead of repeating them", () => {
    const policy = fixtures.wifiPolicies[0];
    assert.equal(
      portal.formatPeakWindows(policy.peakSchedule, t),
      "Sen–Jum 11.30–14.00, 18.00–21.00 · Min, Sab 00.00–23.59",
    );
  });

  test("tier bonuses come from the policy, biggest first", () => {
    const policy = fixtures.wifiPolicies[0];
    assert.equal(
      portal.formatTierBonuses(policy.tierBonusMinutes, t),
      "Platinum 2 jam, Gold 1 jam",
    );
  });

  test("FAC-11 the table menu link does not depend on a Wi-Fi session or login", () => {
    // The QR at the table carries the token; the Wi-Fi sticker does not.
    assert.equal(
      portal.tableMenuToken("st_01JC0QRD4M5N6P7Q8R9S0T1V2W"),
      "st_01JC0QRD4M5N6P7Q8R9S0T1V2W",
    );
    assert.equal(portal.tableMenuToken("  st_token  "), "st_token");
    assert.equal(portal.tableMenuToken(undefined), null);
    assert.equal(portal.tableMenuToken("   "), null);
  });

  test("FAC-12 a refused device tells the guest which limit they hit", () => {
    assert.match(
      portal.startErrorMessage({ code: "WIFI_DEVICE_LIMIT" }, 2, t),
      /2 perangkat/,
    );
    assert.equal(
      portal.startErrorMessage(new Error("network"), 2, t),
      "Wi-Fi belum tersambung. Coba lagi sebentar lagi.",
    );
  });

  test("the device fingerprint is stable input for the API's hash, never the IP", () => {
    const fingerprint = portal.buildDeviceFingerprint({
      deviceId: "device-1",
      userAgent: "Mozilla/5.0",
      width: 390,
      height: 844,
    });
    assert.equal(fingerprint, "device-1|Mozilla/5.0|390x844");
    assert.ok(fingerprint.length >= 8 && fingerprint.length <= 512);
    assert.ok(
      portal.buildDeviceFingerprint({
        deviceId: "x".repeat(600),
        userAgent: "",
        width: 0,
        height: 0,
      }).length <= portal.DEVICE_FINGERPRINT_MAX_LENGTH,
    );
  });
});
