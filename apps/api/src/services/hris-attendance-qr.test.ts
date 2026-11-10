// QR token v2 with per-outlet daily keys (bead legend-cku1m, card C4, design
// docs/design/hris-edge-replication.md §4 and §9 T3). Written BEFORE the
// implementation: it must fail first.
//
// token(window) = "2." + base64url(HMAC-SHA256(dayKey, String(window)))
// dayKey        = HMAC-SHA256(seed, "legend/attendance-qr/v2|" + tenantId + "|" + outletId + "|" + dayIndex)
// dayIndex      = floor(window * 30_000 / 86_400_000)   (UTC day of the window)
//
// The edge never holds the seed: it only has day keys, served through a
// `QrKeySource`. These tests use an in-memory source for the edge side.
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qrWindowOf } from "./hris-attendance-logic.ts";
import {
  deriveQrDayKey,
  deriveQrDayKeys,
  issueQrToken,
  qrDayIndexOfWindow,
  qrTokenForWindow,
  seedQrKeySource,
  validateQr,
  type QrKeySource,
} from "./hris-attendance-qr.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const outletId = "22222222-2222-4222-8222-222222222222";
const otherOutletId = "33333333-3333-4333-8333-333333333333";
const WINDOW_MS = 30_000;
const DAY_MS = 86_400_000;

/** The edge: a read-only map of day keys, as `edge_attendance_qr_keys` holds. */
function edgeSource(keys: Map<number, Uint8Array>): QrKeySource {
  return {
    dayKey: async (_tenant, _outlet, dayIndex) => keys.get(dayIndex) ?? null,
  };
}

/** What the cloud sends in the snapshot: day keys of days from..from+count-1. */
function edgeKeysFrom(seed: Uint8Array, fromDay: number, count: number) {
  return new Map(
    deriveQrDayKeys(seed, tenantId, outletId, fromDay, count).map(
      (entry) => [entry.dayIndex, entry.key] as const,
    ),
  );
}

describe("T3 QR v2 day keys", () => {
  const seed = randomBytes(32);
  const t0 = Date.UTC(2026, 10, 10, 8, 0, 10); // 10 Nov 2026 08:00:10 UTC
  const window = qrWindowOf(t0);
  const day = qrDayIndexOfWindow(window);

  it("derives the day key exactly as the design says", () => {
    expect(day).toBe(Math.floor(t0 / DAY_MS));
    const expected = createHmac("sha256", seed)
      .update(`legend/attendance-qr/v2|${tenantId}|${outletId}|${day}`)
      .digest();
    expect(Buffer.from(deriveQrDayKey(seed, tenantId, outletId, day))).toEqual(
      expected,
    );
  });

  it("separates keys by tenant, outlet, day and seed", () => {
    const key = Buffer.from(deriveQrDayKey(seed, tenantId, outletId, day));
    for (const other of [
      deriveQrDayKey(seed, tenantId, otherOutletId, day),
      deriveQrDayKey(
        seed,
        "44444444-4444-4444-8444-444444444444",
        outletId,
        day,
      ),
      deriveQrDayKey(seed, tenantId, outletId, day + 1),
      deriveQrDayKey(randomBytes(32), tenantId, outletId, day),
    ])
      expect(Buffer.from(other).equals(key)).toBe(false);
  });

  it("makes a v2 token: '2.' + HMAC(dayKey, window) in base64url", () => {
    const dayKey = deriveQrDayKey(seed, tenantId, outletId, day);
    const token = qrTokenForWindow(dayKey, window);
    expect(token.startsWith("2.")).toBe(true);
    expect(token.slice(2)).toBe(
      createHmac("sha256", dayKey).update(String(window)).digest("base64url"),
    );
    expect(qrTokenForWindow(dayKey, window + 1)).not.toBe(token);
  });

  it("derives a run of consecutive day keys", () => {
    const keys = deriveQrDayKeys(seed, tenantId, outletId, day - 1, 5);
    expect(keys.map((entry) => entry.dayIndex)).toEqual([
      day - 1,
      day,
      day + 1,
      day + 2,
      day + 3,
    ]);
    expect(Buffer.from(keys[1]!.key)).toEqual(
      Buffer.from(deriveQrDayKey(seed, tenantId, outletId, day)),
    );
  });

  it("a token shown by the edge (day key only) verifies on the cloud (seed)", async () => {
    const edge = edgeSource(edgeKeysFrom(seed, day - 1, 5));
    const shown = await issueQrToken(edge, tenantId, outletId, t0);
    expect(shown.window).toBe(window);
    const cloud = seedQrKeySource(async () => seed);
    expect(await validateQr(cloud, tenantId, outletId, shown.token, t0)).toBe(
      true,
    );
    // The edge verifies its own token with the same key.
    expect(await validateQr(edge, tenantId, outletId, shown.token, t0)).toBe(
      true,
    );
  });

  it("accepts the previous window, rejects two windows back and a future one", async () => {
    const cloud = seedQrKeySource(async () => seed);
    const dayKey = deriveQrDayKey(seed, tenantId, outletId, day);
    const at = (w: number) => qrTokenForWindow(dayKey, w);
    expect(await validateQr(cloud, tenantId, outletId, at(window), t0)).toBe(
      true,
    );
    expect(
      await validateQr(cloud, tenantId, outletId, at(window - 1), t0),
    ).toBe(true);
    expect(
      await validateQr(cloud, tenantId, outletId, at(window - 2), t0),
    ).toBe(false);
    expect(
      await validateQr(cloud, tenantId, outletId, at(window + 1), t0),
    ).toBe(false);
  });

  it("a seed rotation on the cloud invalidates a token the edge made", async () => {
    const edge = edgeSource(edgeKeysFrom(seed, day - 1, 5));
    const shown = await issueQrToken(edge, tenantId, outletId, t0);
    const rotated = seedQrKeySource(async () => randomBytes(32));
    expect(await validateQr(rotated, tenantId, outletId, shown.token, t0)).toBe(
      false,
    );
  });

  it("uses its own day key at the day boundary", async () => {
    const midnight = (Math.floor(t0 / DAY_MS) + 1) * DAY_MS;
    const lastOfDay = qrWindowOf(midnight - 1);
    const firstOfNext = qrWindowOf(midnight);
    expect(firstOfNext).toBe(lastOfDay + 1);
    expect(qrDayIndexOfWindow(lastOfDay)).toBe(day);
    expect(qrDayIndexOfWindow(firstOfNext)).toBe(day + 1);

    const edge = edgeSource(edgeKeysFrom(seed, day - 1, 5));
    const cloud = seedQrKeySource(async () => seed);
    const early = await issueQrToken(
      edge,
      tenantId,
      outletId,
      midnight + 1_000,
    );
    const lateBefore = await issueQrToken(
      edge,
      tenantId,
      outletId,
      midnight - 1_000,
    );
    // Tokens of the two windows differ and were made with different day keys.
    expect(early.token).not.toBe(lateBefore.token);
    expect(
      early.token.slice(2) ===
        createHmac("sha256", deriveQrDayKey(seed, tenantId, outletId, day + 1))
          .update(String(firstOfNext))
          .digest("base64url"),
    ).toBe(true);
    // 1 s after midnight, the previous window (made with day D's key) is still accepted.
    expect(
      await validateQr(
        cloud,
        tenantId,
        outletId,
        lateBefore.token,
        midnight + 1_000,
      ),
    ).toBe(true);
    expect(
      await validateQr(
        cloud,
        tenantId,
        outletId,
        early.token,
        midnight + 1_000,
      ),
    ).toBe(true);
    // A token made with yesterday's key for the new window is not valid.
    const wrongDayKey = qrTokenForWindow(
      deriveQrDayKey(seed, tenantId, outletId, day),
      firstOfNext,
    );
    expect(
      await validateQr(
        cloud,
        tenantId,
        outletId,
        wrongDayKey,
        midnight + 1_000,
      ),
    ).toBe(false);
  });

  it("rejects a v1 token (no dual-algorithm period) and garbage", async () => {
    const cloud = seedQrKeySource(async () => seed);
    const v1 = createHmac("sha256", seed)
      .update(String(window))
      .digest("base64url");
    expect(await validateQr(cloud, tenantId, outletId, v1, t0)).toBe(false);
    for (const junk of ["", "2.", "2.garbage", "X".repeat(45), "3." + v1])
      expect(await validateQr(cloud, tenantId, outletId, junk, t0)).toBe(false);
  });

  it("rejects when no key is available (no seed, or day not in the edge map)", async () => {
    const dayKey = deriveQrDayKey(seed, tenantId, outletId, day);
    const token = qrTokenForWindow(dayKey, window);
    expect(
      await validateQr(
        seedQrKeySource(async () => null),
        tenantId,
        outletId,
        token,
        t0,
      ),
    ).toBe(false);
    expect(
      await validateQr(edgeSource(new Map()), tenantId, outletId, token, t0),
    ).toBe(false);
  });

  it("a QR display with no key answers 503 QR_KEY_UNAVAILABLE", async () => {
    await expect(
      issueQrToken(edgeSource(new Map()), tenantId, outletId, t0),
    ).rejects.toMatchObject({ status: 503, code: "QR_KEY_UNAVAILABLE" });
    // A key for another day does not help.
    await expect(
      issueQrToken(
        edgeSource(edgeKeysFrom(seed, day + 2, 1)),
        tenantId,
        outletId,
        t0,
      ),
    ).rejects.toMatchObject({ status: 503, code: "QR_KEY_UNAVAILABLE" });
  });

  it("never exposes the seed or the day key in the thrown error", async () => {
    const error = await issueQrToken(
      edgeSource(new Map()),
      tenantId,
      outletId,
      t0,
    ).catch((e: unknown) => e as Error);
    expect(String((error as Error).message)).not.toContain(
      seed.toString("hex"),
    );
  });

  it("keeps the 30 s window length", () => {
    expect(WINDOW_MS).toBe(30_000);
    expect(qrWindowOf(t0)).toBe(Math.floor(t0 / WINDOW_MS));
  });
});
