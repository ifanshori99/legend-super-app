// TEN-08 (bugs legend-ozud, legend-ww29): the installable manifest carries the
// tenant brand, never the platform name, and the design-system showcase copy
// has no platform name.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createTranslator } from "../packages/shared/src/i18n/index.ts";
import { manifestFor } from "../apps/web/src/features/ws08-website/lib/manifest.ts";

const t = createTranslator();
const PLATFORM = /legend super app|ngodingpakeai|powered by/i;

test("TEN-08 manifest name and short_name come from the brand", () => {
  const manifest = manifestFor("Kopi Senja");
  assert.equal(manifest.name, "Kopi Senja");
  assert.equal(manifest.short_name, "Kopi Senja");
  assert.doesNotMatch(JSON.stringify(manifest), PLATFORM);
});

test("TEN-08 manifest short_name is capped for a long brand name", () => {
  const manifest = manifestFor("Warung Kopi Senja Nusantara");
  assert.equal(manifest.name, "Warung Kopi Senja Nusantara");
  assert.ok(manifest.short_name.length <= 12);
});

test("TEN-08 no static platform manifest ships in public/", () => {
  assert.equal(existsSync("apps/web/public/manifest.webmanifest"), false);
});

test("TEN-08 design-system copy does not name the platform", () => {
  assert.doesNotMatch(t("designSystem.title"), PLATFORM);
  assert.doesNotMatch(t("designSystem.intro"), PLATFORM);
});
