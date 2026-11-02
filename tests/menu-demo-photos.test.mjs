import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { cafeLegendMenuFixtures } from "../packages/shared/src/menu/index.ts";
import {
  buildQrMenu,
  qrOrderFixtures,
} from "../packages/shared/src/qr-order/index.ts";
import { demoPhotos } from "../apps/web/src/lib/mock/demo-photos.ts";

const root = resolve(import.meta.dirname, "..");
const sampleDir = resolve(root, "apps/web/demo/sample/menu");
const itemNames = cafeLegendMenuFixtures.items.map((item) => item.name);

test("legend-4pki: every demo menu item maps to a compressed local photo", () => {
  // 61 = 15 Kopi + 15 Nonkopi + 15 Dapur + 15 Pastry + the combo (PRD §8 sample
  // catalogue, owner Q17: the demo may only use licensed Unsplash samples).
  assert.equal(itemNames.length, 61);
  for (const name of itemNames) {
    const url = demoPhotos[name];
    assert.ok(url, `no demo photo for ${name}`);
    assert.match(url, /^\/sample\/menu\/[a-z0-9-]+\.jpg$/, name);
    const file = resolve(sampleDir, url.split("/").at(-1));
    assert.ok(existsSync(file), `missing sample file ${url}`);
    // Owner Q17 / DESIGN.md §4 Media: lightweight demo plates (≤ 80 KB each).
    assert.ok(statSync(file).size <= 80 * 1024, `${url} is over 80 KB`);
  }
});

test("legend-4pki: the demo photo map has no stale keys", () => {
  const names = new Set(itemNames);
  for (const key of Object.keys(demoPhotos))
    assert.ok(names.has(key), `stale demo photo key: ${key}`);
});

test("legend-4pki: photos enter the QR menu only through the mock seam", () => {
  const table = qrOrderFixtures.tables.find((entry) => entry.code === "A03");
  const zone = qrOrderFixtures.zones[0];
  // Shared runtime fixtures never carry sample paths: a real build shows the
  // designed missing-photo state until the outlet's upload exists (Q23).
  const plain = buildQrMenu({ table, zone });
  assert.ok(plain.items.every((item) => item.photoUrl === null));
  const demo = buildQrMenu(
    { table, zone },
    { photoFor: (name) => demoPhotos[name] ?? null },
  );
  for (const item of demo.items)
    assert.equal(item.photoUrl, demoPhotos[item.name] ?? null, item.name);
});

test("legend-4pki: shared runtime fixtures carry no sample photo paths", () => {
  const source = readFileSync(
    resolve(root, "packages/shared/src/qr-order/guest.ts"),
    "utf8",
  );
  assert.equal(source.includes("sample/menu"), false);
});

test("legend-qury: every demo item can be restored after 86 (has a photo)", () => {
  // The back office refuses to re-activate an item without a photo
  // (MENU_PHOTO_REQUIRED, owner Q23); the mock seeds a media row for every
  // item name in the demo map, so 86 → restore works for all 61 demo items.
  const missing = itemNames.filter((name) => !demoPhotos[name]);
  assert.deepEqual(missing, []);
});
