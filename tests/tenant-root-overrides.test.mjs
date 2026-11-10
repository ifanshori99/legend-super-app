// legend-it6p4: root passes the tenant's public text overrides to Providers.
// The web server reads `GET /api/tenant/text-overrides` (terms.* only, no
// session) and never lets a failed read break the page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const {
  toPublicTextOverrides,
  isPublicOverrideKey,
  publicTextOverridesSchema,
} = await import("../packages/shared/src/text/index.ts");
const { overridesForLocale } =
  await import("../apps/web/src/lib/tenant-text-overrides.ts");

const read = (path) =>
  readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), "utf8");

test("legend-it6p4: only terms.* keys are public", () => {
  assert.equal(isPublicOverrideKey("terms.table"), true);
  assert.equal(isPublicOverrideKey("hris.home.greeting"), false);
  assert.equal(isPublicOverrideKey("terms.doesNotExist"), false);
  const grouped = toPublicTextOverrides([
    { locale: "id", key: "terms.table", value: "Meja Kami" },
    { locale: "id", key: "hris.home.greeting", value: "Rahasia" },
    { locale: "xx", key: "terms.table", value: "Salah" },
  ]);
  assert.deepEqual(grouped, { id: { "terms.table": "Meja Kami" }, en: {} });
  assert.equal(publicTextOverridesSchema.safeParse(grouped).success, true);
  assert.equal(
    publicTextOverridesSchema.safeParse({ ...grouped, tenantId: "x" }).success,
    false,
  );
});

test("legend-it6p4: the web picks the Indonesian map and re-checks the allowlist", () => {
  assert.deepEqual(
    overridesForLocale({
      id: { "terms.table": "Meja Kami", "hris.home.greeting": "Bocor" },
      en: { "terms.table": "Our Table" },
    }),
    { "terms.table": "Meja Kami" },
  );
  assert.deepEqual(overridesForLocale(null), {});
});

test("legend-it6p4: the server function treats failures as no overrides", () => {
  const fn = read("lib/tenant-text-overrides-fn.ts");
  assert.match(fn, /\/api\/tenant\/text-overrides/);
  assert.match(fn, /createServerFn\(\{\s*method: "GET",?\s*\}\)/);
  assert.match(fn, /catch/);
  assert.match(fn, /API_MOCK/);
});

test("legend-it6p4: root loads overrides and hands them to Providers", () => {
  const root = read("routes/__root.tsx");
  assert.match(root, /getTenantTextOverridesFn\(\)/);
  assert.match(root, /<Providers overrides=\{overrides\}>/);
  assert.match(read("router.tsx"), /textOverrides: \{\}/);
});
