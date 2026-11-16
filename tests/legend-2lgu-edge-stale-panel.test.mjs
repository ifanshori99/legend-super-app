// legend-2lgu: the edge status screens show a stale and a hard-stale device
// registry from the catalog. Soft: the last pull is late. Hard: past the hard
// limit, the edge refuses new devices while running ones keep working.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import * as edge from "../packages/shared/src/edge/index.ts";
import * as i18n from "../packages/shared/src/i18n/index.ts";
import { registryStaleView } from "../apps/web/src/features/ws02-edge/registry-stale.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const HOUR = 3_600_000;
const t = i18n.createTranslator();

const STALE_KEYS = [
  "deviceRegistry.staleNotice.softTitle",
  "deviceRegistry.staleNotice.softNever",
  "deviceRegistry.staleNotice.softHint",
  "deviceRegistry.staleNotice.hardTitle",
  "deviceRegistry.staleNotice.hardHint",
  "deviceRegistry.staleNotice.rowLabel",
  "deviceRegistry.staleNotice.rowFresh",
  "deviceRegistry.staleNotice.rowStale",
  "deviceRegistry.staleNotice.rowHard",
  "deviceRegistry.staleNotice.rowPulled",
  "deviceRegistry.staleNotice.rowNever",
];

function iso(offsetMs) {
  return new Date(NOW + offsetMs).toISOString();
}

test("stale panel text is registered in the catalog", () => {
  for (const key of STALE_KEYS) {
    assert.equal(i18n.isMessageKey(key), true, key);
    assert.notEqual(t(key), key, `${key} has no catalog text`);
  }
});

test("a fresh registry shows nothing", () => {
  assert.equal(
    registryStaleView(
      { lastPulledAt: iso(-30_000), stale: false, hardStale: false },
      NOW,
    ),
    null,
  );
  // An older edge status without the new fields stays quiet too.
  assert.equal(
    registryStaleView({ lastPulledAt: null, stale: false }, NOW),
    null,
  );
  assert.equal(registryStaleView(undefined, NOW), null);
});

test("a late pull is soft stale and keeps its time", () => {
  const since = iso(-2 * HOUR);
  const view = registryStaleView(
    { lastPulledAt: since, stale: true, hardStale: false },
    NOW,
  );
  assert.deepEqual(view, { kind: "soft", since });
  assert.match(
    t("deviceRegistry.staleNotice.softTitle", { time: "09.00 WIB" }),
    /belum diperbarui sejak 09\.00 WIB/,
  );
});

test("a registry that was never pulled is soft stale without a time", () => {
  assert.deepEqual(
    registryStaleView({ lastPulledAt: null, stale: true }, NOW),
    { kind: "soft", since: null },
  );
});

test("hard stale wins over stale and counts whole hours", () => {
  const view = registryStaleView(
    {
      lastPulledAt: iso(-80 * HOUR - 1_000),
      stale: true,
      hardStale: true,
      maxStaleSeconds: 72 * 3600,
    },
    NOW,
  );
  assert.deepEqual(view, { kind: "hard", hours: 80 });
  const title = t("deviceRegistry.staleNotice.hardTitle", { hours: 80 });
  assert.match(title, /Edge menolak perangkat baru/);
  assert.match(title, /80 jam/);
  assert.match(
    t("deviceRegistry.staleNotice.hardHint"),
    /Perangkat yang sedang aktif tetap berjalan/,
  );
});

test("hard stale without a pull time falls back to the hard limit", () => {
  assert.deepEqual(
    registryStaleView(
      {
        lastPulledAt: null,
        stale: true,
        hardStale: true,
        maxStaleSeconds: 72 * 3600,
      },
      NOW,
    ),
    { kind: "hard", hours: 72 },
  );
});

test("the screens read the stale view and use only catalog keys", async () => {
  const dir = "apps/web/src/features/ws02-edge/components/";
  const notice = await readFile(
    new URL(`../${dir}device-registry-stale-notice.tsx`, import.meta.url),
    "utf8",
  );
  const layer = await readFile(
    new URL(`../${dir}edge-status-layer.tsx`, import.meta.url),
    "utf8",
  );
  const screen = await readFile(
    new URL(`../${dir}koneksi-screen.tsx`, import.meta.url),
    "utf8",
  );
  assert.match(layer, /<DeviceRegistryStaleNotice \/>/);
  assert.match(notice, /registryStaleView\(/);
  for (const source of [notice, screen])
    for (const match of source.matchAll(
      /\bt\(\s*["'](deviceRegistry\.staleNotice\.[^"']+)["']/g,
    ))
      assert.equal(i18n.isMessageKey(match[1]), true, match[1]);
  for (const key of ["hardTitle", "hardHint", "softTitle", "softNever"])
    assert.ok(notice.includes(`deviceRegistry.staleNotice.${key}`), key);
  for (const key of ["rowHard", "rowStale", "rowFresh", "rowPulled"])
    assert.ok(screen.includes(`deviceRegistry.staleNotice.${key}`), key);
});

test("the edge status fixture still parses", () => {
  assert.equal(
    edge.edgeStatusSchema.safeParse(edge.edgeStatusFixture).success,
    true,
  );
});
