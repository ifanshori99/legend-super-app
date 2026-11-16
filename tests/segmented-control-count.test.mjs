// legend-v4ht: SegmentedControl optional `count` chip (SSR render).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = new URL("../apps/web/src/", import.meta.url);
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const ts = rootRequire("typescript");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = new URL(specifier.slice(2), webRoot);
      const extension = [".tsx", ".ts"].find((suffix) =>
        existsSync(`${fileURLToPath(target)}${suffix}`),
      );
      if (extension) return nextResolve(`${target.href}${extension}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { SegmentedControl } = await import(
  new URL("components/ui/segmented-control.tsx", webRoot).href
);

function render(options, props = {}) {
  return renderToStaticMarkup(
    React.createElement(SegmentedControl, {
      value: "a",
      onValueChange: () => {},
      label: "Filter",
      options,
      ...props,
    }),
  );
}

// Each radio button, with its inner markup.
function radios(html) {
  return [...html.matchAll(/<button\b[^>]*role="radio"[^>]*>(.*?)<\/button>/g)];
}

test("v4ht: without count there is no chip", () => {
  const html = render([
    { value: "a", label: "Baru" },
    { value: "b", label: "Siap" },
  ]);
  assert.equal(radios(html).length, 2);
  assert.doesNotMatch(html, /tabular-nums/);
  assert.doesNotMatch(html, /rounded-full/);
});

test("v4ht: count 0 still renders the number 0", () => {
  const html = render([
    { value: "a", label: "Baru", count: 0 },
    { value: "b", label: "Siap" },
  ]);
  const [first, second] = radios(html);
  assert.match(first[1], /<span[^>]*tabular-nums[^>]*>0<\/span>/);
  assert.doesNotMatch(second[1], /tabular-nums/);
});

test("v4ht: count chip is tabular-nums, role radio stays, name reads 'label count'", () => {
  const html = render([
    { value: "a", label: "Baru", count: 12 },
    { value: "b", label: "Siap", count: 3 },
  ]);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /aria-label="Filter"/);
  const items = radios(html);
  assert.equal(items.length, 2);
  // The number is plain text in the radio (no aria-hidden), after the label.
  assert.match(items[0][1], /Baru<span[^>]*tabular-nums[^>]*>12<\/span>/);
  assert.match(items[1][1], /Siap<span[^>]*tabular-nums[^>]*>3<\/span>/);
  assert.doesNotMatch(items[0][1], /aria-hidden="true"[^>]*>12/);
  // Text content that forms the accessible name.
  const text = (inner) =>
    inner
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  assert.equal(text(items[0][1]), "Baru 12");
  assert.equal(text(items[1][1]), "Siap 3");
});

test("v4ht: selection ink and page change the checked fill and chip fill", () => {
  const options = [{ value: "a", label: "Baru", count: 2 }];
  const ink = render(options, { selection: "ink" });
  assert.match(ink, /data-\[state=checked\]:bg-foreground/);
  assert.match(ink, /group-data-\[state=checked\]\/seg:bg-background/);
  assert.doesNotMatch(ink, /data-\[state=checked\]:bg-card/);

  const page = render(options);
  assert.match(page, /data-\[state=checked\]:bg-card/);
  assert.match(page, /group-data-\[state=checked\]\/seg:bg-surface-2/);
  assert.doesNotMatch(page, /data-\[state=checked\]:bg-foreground/);
});
