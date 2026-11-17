// Design System Platform contract tests (WS-00): WCAG 2.2 AA theme gate,
// CSS/TS token parity, Rupiah formatting, and the text catalog.
// Loads the TypeScript sources directly through Node type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
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

const root = resolve(import.meta.dirname, "..");
const theme = await import("../packages/shared/src/theme/index.ts");
const i18n = await import("../packages/shared/src/i18n/index.ts");

const {
  basePalettes,
  kontrasPalettes,
  kontrasOverrides,
  cafeLegendTheme,
  checkPalettes,
  checkTenantTheme,
  buildTenantThemeCss,
  contrastRatio,
  relativeLuminance,
  COLOR_TOKENS,
} = theme;

const paleTenant = theme.failingThemeExample;

test("contrast ratio matches WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21, "order-independent");
  // #767676 is the lightest grey that passes 4.5:1 on white.
  assert.ok(contrastRatio("#767676", "#ffffff") >= 4.5);
  assert.ok(contrastRatio("#777777", "#ffffff") < 4.5);
  assert.throws(() => relativeLuminance("#fff"), /#rrggbb/);
  assert.throws(() => relativeLuminance("red"), /#rrggbb/);
});

test("Base Theme passes AA in light and dark", () => {
  const result = checkPalettes(basePalettes);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(basePalettes.light.background, "#ffffff", "white default");
  for (const mode of ["light", "dark"])
    assert.deepEqual(
      Object.keys(basePalettes[mode]).sort(),
      [...COLOR_TOKENS].sort(),
      `${mode} defines every token`,
    );
});

test("Kontras Tinggi palettes pass AA, including dark kitchen", () => {
  const result = checkPalettes(kontrasPalettes());
  assert.deepEqual(result.failures, []);
  assert.ok(
    contrastRatio(
      kontrasPalettes().dark.foreground,
      kontrasPalettes().dark.background,
    ) >= 18,
    "kitchen text is close to black/white",
  );
});

test("Cafe Legend placeholder Tenant Theme passes and activates", () => {
  assert.equal(cafeLegendTheme.placeholder, true);
  assert.equal(checkTenantTheme(basePalettes, cafeLegendTheme).ok, true);
  const built = buildTenantThemeCss(cafeLegendTheme);
  assert.equal(built.ok, true);
  assert.match(built.css, /\[data-tenant="cafe-legend"\] \{/);
  assert.match(built.css, /--primary: #8a4423;/);
  assert.match(built.css, /\.dark \[data-tenant="cafe-legend"\]/);
});

test("a tenant theme failing AA cannot activate", () => {
  const result = checkTenantTheme(basePalettes, paleTenant);
  assert.equal(result.ok, false);
  const failure = result.failures.find(
    (f) => f.fg === "primary-foreground" && f.bg === "primary",
  );
  assert.ok(failure, "names the failing pair");
  assert.equal(failure.mode, "light");
  assert.ok(failure.ratio < 4.5);
  const built = buildTenantThemeCss(paleTenant);
  assert.equal(built.ok, false);
  assert.equal(built.css, null);
});

test("dark mode is checked even when a tenant only overrides it", () => {
  const darkOnly = {
    id: "gelap-saja",
    name: "Gelap saja",
    colors: { dark: { brand: "#3a3a3a", "brand-foreground": "#444444" } },
  };
  const result = checkTenantTheme(basePalettes, darkOnly);
  assert.equal(result.ok, false);
  assert.ok(result.failures.every((f) => f.mode === "dark"));
});

test("invalid colors and tenant ids are refused before activation", () => {
  const badColor = {
    id: "warna-salah",
    name: "Warna salah",
    colors: { light: { primary: "orange" } },
  };
  const check = checkTenantTheme(basePalettes, badColor);
  assert.equal(check.ok, false);
  assert.deepEqual(check.invalid, ["light.primary: orange"]);
  assert.equal(buildTenantThemeCss(badColor).ok, false);

  const injected = { ...cafeLegendTheme, id: 'x"] { color: red } [a="' };
  const built = buildTenantThemeCss(injected);
  assert.equal(built.ok, false);
  assert.equal(built.reason, "invalid tenant id");
});

// tokens.css mirrors base.ts; a silent drift would ship colors that were
// never contrast-checked.
function readPaletteBlock(css, name) {
  const match = css.match(
    new RegExp(`/\\* @palette ${name} \\*/([\\s\\S]*?)/\\* @end \\*/`),
  );
  assert.ok(match, `tokens.css has a "${name}" palette block`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
      m[1],
      m[2].toLowerCase(),
    ]),
  );
}

test("tokens.css palettes match the checked TypeScript palettes", () => {
  const css = readFileSync(
    resolve(root, "apps/web/src/styles/tokens.css"),
    "utf8",
  );
  assert.deepEqual(readPaletteBlock(css, "light"), basePalettes.light);
  assert.deepEqual(readPaletteBlock(css, "dark"), basePalettes.dark);
  assert.deepEqual(
    readPaletteBlock(css, "kontras-light"),
    kontrasOverrides.light,
  );
  assert.deepEqual(
    readPaletteBlock(css, "kontras-dark"),
    kontrasOverrides.dark,
  );
});

// The v2 tint ramp is derived in CSS with color-mix; the gate computes the
// same mix in TypeScript. Both must use the same source, percentage, and base.
test("tokens.css derived accent ramp matches DERIVED_TOKENS", () => {
  const css = readFileSync(
    resolve(root, "apps/web/src/styles/tokens.css"),
    "utf8",
  );
  // Prettier may wrap long declarations; compare on collapsed whitespace.
  const flat = css
    .replace(/\s+/g, " ")
    .replace(/\(\s/g, "(")
    .replace(/\s\)/g, ")");
  for (const [token, rule] of Object.entries(theme.DERIVED_TOKENS)) {
    const decl = `--${token}: color-mix(in srgb, var(--${rule.from}) ${rule.pct}%, var(--${rule.into}));`;
    assert.ok(flat.includes(decl), `tokens.css declares ${decl}`);
  }
  assert.equal(theme.mixHex("#000000", "#ffffff", 50), "#808080");
  assert.equal(theme.mixHex("#8a4423", "#ffffff", 100), "#8a4423");
});

test("derived tint ramp follows each tenant primary and passes AA", () => {
  const merged = theme.mergeTenantPalettes(basePalettes, cafeLegendTheme);
  const full = theme.derivePalette(merged.light);
  assert.equal(full["primary-tint"], theme.mixHex("#8a4423", "#ffffff", 10));
  assert.notEqual(
    full["primary-tint"],
    theme.derivePalette(basePalettes.light)["primary-tint"],
    "a tenant primary changes the ramp with no extra token",
  );
  assert.equal(checkTenantTheme(basePalettes, cafeLegendTheme).ok, true);
});

test("Rupiah formatting is deterministic Indonesian notation", () => {
  const { formatRupiah, formatNumber } = i18n;
  assert.equal(formatRupiah(25000), "Rp25.000");
  assert.equal(formatRupiah(1250000), "Rp1.250.000");
  assert.equal(formatRupiah(-5000), "\u2212Rp5.000");
  assert.equal(formatRupiah(0), "Rp0");
  assert.equal(formatRupiah(-0), "Rp0");
  assert.equal(formatRupiah(9007199254740993n), "Rp9.007.199.254.740.993");
  assert.equal(formatRupiah(1999.5), "Rp2.000");
  assert.doesNotMatch(formatRupiah(38000), /[\s ]/);
  assert.throws(() => formatRupiah(Number.NaN), RangeError);
  assert.throws(() => formatRupiah(Number.POSITIVE_INFINITY), RangeError);
  assert.equal(formatNumber(1234567), "1.234.567");
  assert.equal(formatNumber(12.5, { fractionDigits: 1 }), "12,5");
});

test("text catalog translates, interpolates, and accepts tenant overrides", () => {
  const { createTranslator } = i18n;
  const t = createTranslator();
  assert.equal(t("orderStatus.ready"), "Siap");
  assert.equal(t("timer.elapsed", { minutes: 7 }), "7 menit berjalan");
  assert.equal(t("table.page", { page: 2 }), "Halaman 2 dari {total}");
  assert.equal(t("does.not.exist"), "does.not.exist");
  const tenant = createTranslator(undefined, {
    "nav.customer.menu": "Daftar Menu",
  });
  assert.equal(tenant("nav.customer.menu"), "Daftar Menu");
  assert.equal(tenant("nav.customer.orders"), "Pesanan");
});

test("every catalog entry is real Indonesian copy", () => {
  const leaves = [];
  (function walk(node, path) {
    for (const [key, value] of Object.entries(node))
      if (typeof value === "string") leaves.push([`${path}${key}`, value]);
      else walk(value, `${path}${key}.`);
  })(i18n.messagesId, "");
  assert.ok(leaves.length > 50);
  for (const [key, value] of leaves) {
    assert.ok(value.trim().length > 0, `${key} is empty`);
    assert.doesNotMatch(
      value,
      /lorem|ipsum|TODO|XXX/i,
      `${key} is placeholder`,
    );
  }
});
