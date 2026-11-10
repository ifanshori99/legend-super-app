// legend-1v1g: root renders the tenant theme resolved from the request host.
// The web server reads `GET /api/tenant/context` (PRD "Gambaran Sistem",
// D44, D43 whitelabel) and maps the brand's active theme into the
// TenantThemeConfig that TenantThemeStyle renders.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Shared sources use bundler-style extensionless imports; let Node try ".ts".
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

const { cafeLegendPlatformFixtures } = await import(
  "../packages/shared/src/platform/fixtures.ts"
);
const { buildTenantThemeCss } = await import(
  "../packages/shared/src/theme/index.ts"
);
const { brandContextToThemeConfig } = await import(
  "../apps/web/src/lib/tenant-brand.ts"
);

const context = cafeLegendPlatformFixtures.brandContext;

test("legend-1v1g: a brand with an active theme maps to a renderable TenantThemeConfig", () => {
  assert.ok(context.theme, "fixture has an active theme");
  const config = brandContextToThemeConfig(context);
  assert.ok(config);
  assert.equal(config.id, context.brand.slug);
  assert.equal(config.name, context.brand.name);
  assert.equal(config.font, context.theme.fontFamily);
  assert.equal(config.corners, context.theme.corners);
  assert.deepEqual(config.colors, context.theme.tokens);
  // The result must be accepted by the CSS builder, scoped to data-tenant.
  const built = buildTenantThemeCss(config);
  assert.equal(built.ok, true);
  assert.match(built.css, new RegExp(`data-tenant="${config.id}"`));
});

test("legend-1v1g: no active theme or no context means the base theme stays", () => {
  assert.equal(
    brandContextToThemeConfig({ ...context, theme: null }),
    null,
  );
  assert.equal(brandContextToThemeConfig(null), null);
});

// Wiring guards: reverting the root or AreaFrame wiring must fail a test.
test("legend-1v1g / legend-b0l9: root and AreaFrame stay wired", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) =>
    readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), "utf8");
  const root = read("routes/__root.tsx");
  assert.match(root, /<TenantThemeStyle tenant=\{tenantTheme\} \/>/);
  assert.match(root, /data-tenant=\{tenantTheme\?\.id\}/);
  assert.match(root, /getTenantBrandFn\(\)/);
  const frame = read("components/layout/area-frame.tsx");
  assert.match(frame, /useCloudConnection\(/);
  assert.doesNotMatch(frame, /useOnline\(/);
  assert.match(read("components/providers.tsx"), /overrides=\{overrides\}/);
});
