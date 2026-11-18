import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as i18n from "../packages/shared/src/i18n/index.ts";
import * as text from "../packages/shared/src/text/index.ts";
import { ACCOUNTING_ERROR_CODES } from "../packages/shared/src/accounting/index.ts";
import { taxErrorMessageKey } from "../apps/web/src/features/ws07-tax/lib.ts";

// WS-00 text contract: catalog, tenant term dictionary and text_overrides
// (PRD §3 F4 "Teks & Kamus Istilah", §6 `text_overrides`, §2 "UI Bahasa
// Indonesia"). TEN-02 for the tenant boundary; TEN-07 for hardcoded strings.

const tenantId = cafeLegendFixtures.tenant.id;

test("legend-0cnqt WS-07 every tax report error has specific catalog text", () => {
  const t = i18n.createTranslator();
  for (const code of ACCOUNTING_ERROR_CODES.filter((value) =>
    value.startsWith("TAX_REPORT_"),
  )) {
    const key = taxErrorMessageKey(code);
    assert.notEqual(key, "accounting.tax.errors.generic", code);
    assert.ok(i18n.isMessageKey(key), `${code}: ${key}`);
    assert.notEqual(t(key), key, code);
    assert.ok(t(key).trim().length > 0, code);
  }
});

test("Cafe Legend term overrides parse and are unique per tenant, locale and key", () => {
  const fixture = text.cafeLegendTextFixtures;
  assert.ok(text.textFixtureSchema.parse(fixture));
  assert.ok(fixture.overrides.length >= 4);
  const keys = fixture.overrides.map(
    (row) => `${row.tenantId}:${row.locale}:${row.key}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  for (const row of fixture.overrides)
    assert.equal(row.tenantId, tenantId, row.key);
});

test("term dictionary resolves tenant overrides over the Indonesian catalog", () => {
  const dictionary = text.createTermDictionary({
    tenantId,
    overrides: text.cafeLegendTextFixtures.overrides,
  });
  assert.equal(dictionary.locale, "id");
  assert.equal(dictionary.term("terms.table"), "Meja");
  assert.equal(dictionary.term("terms.stationBarKopi"), "Kopi");
  assert.equal(dictionary.term("terms.showerRoom"), "Shower Room Legend");
  assert.equal(dictionary.resolve("terms.table").source, "catalog");
  assert.equal(dictionary.resolve("terms.stationBarKopi").source, "tenant");
  assert.equal(dictionary.entries().length, text.TERM_DEFINITIONS.length);
  const t = i18n.createTranslator(i18n.messagesId, dictionary.messageOverrides);
  assert.equal(t("terms.stationPastry"), "Pastry");
});

test("English rows win over id rows, which win over the catalog", () => {
  const dictionary = text.createTermDictionary({
    tenantId,
    locale: "en",
    overrides: text.cafeLegendTextFixtures.overrides,
  });
  assert.equal(dictionary.term("terms.table"), "Table");
  // English row beats the Indonesian row for the same key.
  assert.equal(dictionary.term("terms.stationBarKopi"), "Coffee Bar");
  // No English row: the tenant's Indonesian word still applies.
  assert.equal(dictionary.term("terms.showerRoom"), "Shower Room Legend");
  assert.equal(dictionary.resolve("terms.showerRoom").source, "tenant");
  // No tenant row at all: the catalog default applies.
  assert.equal(dictionary.term("terms.tierGold"), "Gold");
  assert.equal(dictionary.resolve("terms.tierGold").source, "catalog");
});

test("term lookups fail closed on foreign tenants, duplicate rows and unknown terms", () => {
  const overrides = text.cafeLegendTextFixtures.overrides;
  assert.throws(
    () =>
      text.createTermDictionary({
        tenantId: "11111111-1111-4111-8111-111111111111",
        overrides,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      text.createTermDictionary({
        tenantId,
        overrides: [...overrides, overrides[0]],
      }),
    RangeError,
  );
  const dictionary = text.createTermDictionary({ tenantId, overrides });
  assert.throws(() => dictionary.term("common.save"), RangeError);
  assert.throws(() => text.termDefinitionOf("common.save"), RangeError);
});

test("override schemas reject unknown keys, blank values and client-supplied tenants", () => {
  const row = text.cafeLegendTextFixtures.overrides[0];
  for (const patch of [
    { key: "terms.notInCatalog" },
    { key: "nope" },
    { value: "   " },
    { value: "" },
    { locale: "fr" },
    { tenantId: "bad" },
    { updatedAt: "2026-11-01" },
  ])
    assert.equal(
      text.textOverrideSchema.safeParse({ ...row, ...patch }).success,
      false,
      JSON.stringify(patch),
    );

  const input = { key: "terms.table", value: "Meja" };
  assert.deepEqual(text.textOverrideInputSchema.parse(input), {
    ...input,
    locale: "id",
  });
  assert.equal(
    text.textOverrideInputSchema.safeParse({ ...input, tenantId }).success,
    false,
  );
  assert.equal(
    text.textOverrideSetSchema.safeParse({
      locale: "id",
      overrides: [
        { key: "terms.table", value: "Meja" },
        { key: "terms.table", value: "Table" },
      ],
    }).success,
    false,
  );
});

test("every registered term is catalog text and every terms key is registered", () => {
  const t = i18n.createTranslator();
  for (const term of text.TERM_DEFINITIONS) {
    assert.ok(term.key.startsWith("terms."), term.key);
    assert.ok(i18n.isMessageKey(term.key), term.key);
    const value = t(term.key);
    assert.notEqual(value, term.key, `${term.key} has no catalog text`);
    assert.ok(value.trim().length > 0, `${term.key} is empty`);
  }
  const registry = text.TERM_DEFINITIONS.map((term) => term.key);
  assert.equal(new Set(registry).size, registry.length);
  const catalogTerms = i18n.MESSAGE_KEYS.filter((key) =>
    key.startsWith("terms."),
  );
  assert.deepEqual([...registry].sort(), [...catalogTerms].sort());
  for (const term of text.TERM_CATALOG) text.termDefinitionSchema.parse(term);
});

test("text overrides have a WS-00 event and a strict payload", () => {
  assert.deepEqual(
    text.textEventCatalog.map((entry) => entry.name),
    ["text_override.updated"],
  );
  assert.equal(text.textEventCatalog[0].workstream, "WS-00");
  assert.ok(
    events.eventCatalog.some((entry) => entry.name === "text_override.updated"),
  );
  assert.equal(
    text.textOverrideUpdatedEvent.payloadSchemaRef,
    "text_override.updated.v1",
  );
  const payload = text.TEXT_EVENT_PAYLOADS["text_override.updated"];
  assert.ok(
    payload.parse({
      key: "terms.table",
      locale: "id",
      previousValue: null,
      value: "Meja",
    }),
  );
  for (const patch of [
    { key: "terms.nope" },
    { locale: "fr" },
    { previousValue: 1 },
  ])
    assert.equal(
      payload.safeParse({
        key: "terms.table",
        locale: "id",
        previousValue: null,
        value: null,
        ...patch,
      }).success,
      false,
      JSON.stringify(patch),
    );
});

// --- TEN-07-style static check for UI copy -------------------------------
// The catalog is the only place UI text may live. This rule parses the web
// app with the TypeScript AST and flags literal JSX text and literal display
// props. It is a heuristic: a code review still decides whether a string is
// copy, and `// i18n-exempt` documents the rare deliberate exception.

const DISPLAY_PROPS = new Set([
  "title",
  "label",
  "placeholder",
  "alt",
  "description",
  "hint",
  "summary",
  "message",
  "confirmText",
  "cancelText",
  "emptyTitle",
  "emptyHint",
  "errorTitle",
  "errorHint",
  "tooltip",
  "heading",
  "aria-label",
  "aria-description",
]);
const NON_COPY_PROPS = new Set(["aria-hidden", "aria-busy", "aria-live"]);
const CODE_TAGS = new Set(["code", "pre", "kbd", "samp"]);
const HAS_WORD = /[A-Za-z]{2,}/;

export function findHardcodedText(source, filename = "Component.tsx") {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines = source.split("\n");
  const hits = [];
  const isExempt = (node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return /i18n-exempt/.test(lines[line] ?? "");
  };
  const add = (node, kind, value) =>
    hits.push({
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      kind,
      text: value,
    });
  const checkAttributes = (element) => {
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const name = attribute.name.getText(file);
      if (NON_COPY_PROPS.has(name) || !DISPLAY_PROPS.has(name)) continue;
      const initializer = attribute.initializer;
      const literal =
        initializer && ts.isStringLiteral(initializer)
          ? initializer
          : initializer &&
              ts.isJsxExpression(initializer) &&
              initializer.expression &&
              ts.isStringLiteral(initializer.expression)
            ? initializer.expression
            : undefined;
      if (!literal || !HAS_WORD.test(literal.text) || isExempt(literal))
        continue;
      add(literal, `prop ${name}`, literal.text);
    }
  };
  const visit = (node, inCode) => {
    if (ts.isJsxElement(node)) {
      checkAttributes(node.openingElement);
      const childInCode =
        inCode || CODE_TAGS.has(node.openingElement.tagName.getText(file));
      for (const child of node.children) visit(child, childInCode);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      checkAttributes(node);
      return;
    }
    if (ts.isJsxText(node) && !inCode) {
      const value = node.text.replace(/\s+/g, " ").trim();
      if (HAS_WORD.test(value) && !isExempt(node)) add(node, "text", value);
      return;
    }
    if (
      ts.isJsxExpression(node) &&
      !inCode &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      HAS_WORD.test(node.expression.text) &&
      !isExempt(node)
    ) {
      add(node, "text", node.expression.text);
    }
    ts.forEachChild(node, (child) => visit(child, inCode));
  };
  visit(file, false);
  return hits;
}

const webRoot = path.resolve(import.meta.dirname, "../apps/web/src");

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

// Starter screens still carry English copy. Each entry must disappear when the
// WS-00 FE route skeleton (bead legend-fbu) replaces the starter page; the
// last test fails if an entry is no longer needed.
const STARTER_PAGES = new Map([
  [
    "components/auth-form.tsx",
    "Starter auth form; WS-01 login screens replace it.",
  ],
  [
    "components/design-system/token-sections.tsx",
    "Token documentation shows raw token values and sample data.",
  ],
  [
    "components/sign-out-button.tsx",
    "Starter sign-out button; WS-01 converts it to catalog text.",
  ],
]);

test("the hardcoded-text rule flags literals and accepts catalog calls", () => {
  assert.deepEqual(
    findHardcodedText(
      `export function A() { return <button title="Simpan">Simpan</button>; }`,
    ).map((hit) => hit.text),
    ["Simpan", "Simpan"],
  );
  assert.deepEqual(
    findHardcodedText(
      `export function B({ t }) { return <button title={t("common.save")}>{t("common.save")}</button>; }`,
    ),
    [],
  );
  assert.deepEqual(
    findHardcodedText(
      `export function C() { return <p><code>pnpm dev</code></p>; }`,
    ),
    [],
  );
  assert.deepEqual(
    findHardcodedText(
      `export function D() { return <span>Meja 12</span>; } // i18n-exempt`,
    ),
    [],
  );
});

test("every app string comes from the catalog", async () => {
  const violations = [];
  for (const file of await sourceFiles(webRoot)) {
    const relative = path.relative(webRoot, file).split(path.sep).join("/");
    if (STARTER_PAGES.has(relative)) continue;
    for (const hit of findHardcodedText(await readFile(file, "utf8"), file))
      violations.push(`${relative}:${hit.line} ${hit.kind} ${hit.text}`);
  }
  assert.deepEqual(
    violations,
    [],
    `UI text must come from the catalog (t("…")):\n${violations.join("\n")}`,
  );
});

test("starter exemptions stay honest", async () => {
  for (const [relative] of STARTER_PAGES) {
    const file = path.join(webRoot, relative);
    const hits = findHardcodedText(await readFile(file, "utf8"), file);
    assert.ok(
      hits.length > 0,
      `${relative} no longer has hardcoded text; remove its exemption`,
    );
  }
});

test("every t() key used in the web app exists in the catalog", async () => {
  const missing = [];
  for (const file of await sourceFiles(webRoot)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g))
      if (!i18n.isMessageKey(match[1]))
        missing.push(`${path.relative(webRoot, file)}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
});
