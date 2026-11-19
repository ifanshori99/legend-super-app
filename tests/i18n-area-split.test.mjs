import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { AREA_MANIFEST } from "../packages/shared/src/i18n/area-manifest.ts";
import { messagesId } from "../packages/shared/src/i18n/index.ts";

// legend-nmn9j (ws/1123-perf-web-i18n): the web catalog is split per route
// area. These tests pin the manifest contract, not the Vite plugin.
//
// Assumptions (the manifest file does not exist yet when this is written):
// - `area-manifest.ts` exports `AREA_MANIFEST`: a plain object mapping a
//   top-level catalog namespace to a chunk name, "core" or an area key.
// - A namespace missing from the manifest is core (brief: "tak terdaftar =
//   core"), so the split is always complete.
// - Area chunk names equal the area keys of `lib/areas/definitions.ts`
//   (`_auth` has no chunk of its own, so its keys must live in core).
// - Lazy-loaded keys (safety net in the web store) are not modelled here: a
//   literal `t("ns.x")` under `routes/_<area>` must be in core or in that
//   area's chunk, without relying on the lazy fallback.

const AREAS = [
  "public",
  "customer",
  "ops",
  "kitchen",
  "kelola",
  "owner",
  "shareholder",
  "karyawan",
  "platform",
];
const CHUNKS = ["core", ...AREAS];

// Namespaces that are built dynamically or shared across areas (brief,
// "Fakta dari pemetaan"). They must always ship in core.
const MUST_BE_CORE = [
  "kds",
  "supportAccess",
  "approvals",
  "deviceRegistry",
  "devicePin",
  "qrRecovery",
  "aiChat",
  "theme",
  "status",
  "nav",
  "facility",
  "hrisRequestsCommon",
  "hrisRequestsQueue",
  "payslipPin",
  "payrollPayoutReview",
  "payrollRun",
  "payrollPayout",
  "staffAuth",
  "login",
  "qrGlass",
  "qrOrders",
  "edge",
  "common",
  "toast",
  "app",
  "shell",
  "errorPage",
];

const chunkOf = (namespace) => AREA_MANIFEST[namespace] ?? "core";

function leafKeys(node, prefix = "") {
  if (typeof node === "string") return [prefix.slice(0, -1)];
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    leafKeys(value, `${prefix}${key}.`),
  );
}

function buildChunks() {
  const chunks = Object.fromEntries(CHUNKS.map((name) => [name, {}]));
  for (const [namespace, value] of Object.entries(messagesId))
    chunks[chunkOf(namespace)][namespace] = value;
  return chunks;
}

test("manifest only lists catalog namespaces and known chunk names", () => {
  const entries = Object.entries(AREA_MANIFEST);
  assert.ok(entries.length > 0, "manifest is empty");
  for (const [namespace, chunk] of entries) {
    assert.ok(
      Object.hasOwn(messagesId, namespace),
      `manifest namespace "${namespace}" is not a top-level key of the id catalog`,
    );
    assert.ok(
      CHUNKS.includes(chunk),
      `namespace "${namespace}" maps to unknown chunk "${chunk}"`,
    );
  }
  assert.ok(
    entries.some(([, chunk]) => chunk !== "core"),
    "manifest puts every namespace in core; nothing is split",
  );
});

test("core plus the area chunks rebuild the id catalog exactly", () => {
  const chunks = buildChunks();
  const merged = Object.assign({}, ...Object.values(chunks));
  assert.deepEqual(merged, messagesId);

  const total = leafKeys(messagesId).length;
  const split = Object.values(chunks).reduce(
    (sum, chunk) => sum + leafKeys(chunk).length,
    0,
  );
  assert.equal(split, total, "a key is lost or duplicated by the split");

  const seen = new Set();
  for (const chunk of Object.values(chunks))
    for (const key of leafKeys(chunk)) {
      assert.ok(!seen.has(key), `${key} appears in two chunks`);
      seen.add(key);
    }
});

test("cross-area and dynamic namespaces stay in core", () => {
  for (const namespace of MUST_BE_CORE) {
    assert.ok(
      Object.hasOwn(messagesId, namespace),
      `required core namespace "${namespace}" is not in the id catalog`,
    );
    assert.equal(
      chunkOf(namespace),
      "core",
      `namespace "${namespace}" must be in core, manifest says "${chunkOf(namespace)}"`,
    );
  }
});

const routesRoot = path.resolve(import.meta.dirname, "../apps/web/src/routes");

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

test("literal t() keys under routes/_<area> are in core or that area's chunk", async () => {
  const problems = [];
  for (const area of AREAS) {
    const dir = path.join(routesRoot, `_${area}`);
    let files;
    try {
      files = await sourceFiles(dir);
    } catch {
      continue; // an area without a routes folder has nothing to check
    }
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
        const key = match[1];
        const namespace = key.split(".")[0];
        // Unknown keys are the job of text-contract.test.mjs.
        if (!Object.hasOwn(messagesId, namespace)) continue;
        const chunk = chunkOf(namespace);
        if (chunk !== "core" && chunk !== area)
          problems.push(
            `${path.relative(routesRoot, file)}: ${key} lives in chunk "${chunk}", not core or "${area}"`,
          );
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("literal t() keys under routes/_auth are in core", async () => {
  const problems = [];
  for (const file of await sourceFiles(path.join(routesRoot, "_auth"))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
      const namespace = match[1].split(".")[0];
      if (!Object.hasOwn(messagesId, namespace)) continue;
      if (chunkOf(namespace) !== "core")
        problems.push(
          `${path.relative(routesRoot, file)}: ${match[1]} is in chunk "${chunkOf(namespace)}"`,
        );
    }
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Import-graph check (port of the reachability pass of the namespace matrix
// that produced the manifest): a string literal equal to a catalog key, in a
// web file reachable from exactly one route area, must live in core or in that
// area's chunk. A file reachable from the document shell, `_auth`, a route
// outside the areas, or two areas needs core. Keys built at run time are not
// seen here; the web store's lazy load covers them.
// ---------------------------------------------------------------------------

const webSrc = path.resolve(import.meta.dirname, "../apps/web/src");

async function allSourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      files.push(...(await allSourceFiles(full)));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.|\.d\.ts$/.test(entry.name) &&
      entry.name !== "routeTree.gen.ts"
    )
      files.push(full);
  }
  return files;
}

// Mock code is compiled out of production (API_MOCK), so no edges into it.
const isMock = (file) =>
  /[\\/]lib[\\/]mock[\\/]|[\\/](mock|[^\\/]*-mock|mock-[^\\/]*)\.tsx?$/.test(
    file,
  );

function globToRegExp(absolutePattern) {
  const source = absolutePattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`);
}

test("literal catalog keys in area-only web files are in core or that area's chunk", async () => {
  const files = await allSourceFiles(webSrc);
  const fileSet = new Set(files);
  const text = new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")]),
    ),
  );

  const resolveSpecifier = (from, specifier) => {
    let base;
    if (specifier.startsWith("@/"))
      base = path.join(webSrc, specifier.slice(2));
    else if (specifier.startsWith("."))
      base = path.resolve(path.dirname(from), specifier);
    else return undefined;
    return [
      base,
      base.replace(/\.(m?js)$/, ".ts"),
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ].find((candidate) => fileSet.has(candidate));
  };

  const importPattern = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]+)["']/g;
  const globPattern =
    /import\.meta\.glob(?:<[^>(]*>)?\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g;
  const graph = new Map();
  for (const file of files) {
    const source = text.get(file);
    const edges = new Set();
    for (const match of source.matchAll(importPattern)) {
      const target = resolveSpecifier(file, match[1]);
      if (target && !isMock(target)) edges.add(target);
    }
    for (const glob of source.matchAll(globPattern))
      for (const part of glob[1].matchAll(/["']([^"']+)["']/g)) {
        if (part[1].startsWith("!")) continue;
        const absolute = part[1].startsWith("/")
          ? path.join(webSrc, "..", part[1])
          : path.resolve(path.dirname(file), part[1]);
        const pattern = globToRegExp(absolute);
        for (const candidate of files)
          if (pattern.test(candidate) && !isMock(candidate))
            edges.add(candidate);
      }
    graph.set(file, edges);
  }

  // Seeds: the document shell, then every route file tagged with its area.
  const shellFiles = [
    "routes/__root.tsx",
    "router.tsx",
    "start.ts",
    "server.ts",
  ]
    .map((name) => path.join(webSrc, name))
    .filter((file) => fileSet.has(file));
  const seeds = shellFiles.map((file) => [file, "shell"]);
  for (const file of files) {
    if (!file.startsWith(routesRoot + path.sep) || shellFiles.includes(file))
      continue;
    const first = path.relative(routesRoot, file).split(path.sep)[0];
    const tag =
      first.startsWith("_") && !first.startsWith("__")
        ? first.replace(/\.tsx?$/, "").slice(1)
        : "standalone";
    seeds.push([file, tag]);
  }
  const tags = new Map();
  for (const [seed, tag] of seeds) {
    const stack = [seed];
    while (stack.length) {
      const file = stack.pop();
      let set = tags.get(file);
      if (!set) tags.set(file, (set = new Set()));
      if (set.has(tag)) continue;
      set.add(tag);
      for (const next of graph.get(file) ?? []) stack.push(next);
    }
  }

  const keys = new Set(leafKeys(messagesId));
  const stringPattern =
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/g;
  const problems = [];
  for (const file of files) {
    const fileTags = tags.get(file);
    if (!fileTags) continue; // unreachable from any route: not shipped
    for (const match of text.get(file).matchAll(stringPattern)) {
      const literal = match[1] ?? match[2] ?? match[3];
      if (!literal || !keys.has(literal)) continue;
      const chunk = chunkOf(literal.split(".")[0]);
      if (chunk === "core") continue;
      if (fileTags.size === 1 && fileTags.has(chunk)) continue;
      problems.push(
        `${path.relative(webSrc, file)}: ${literal} is in chunk "${chunk}" but the file is reachable from ${[...fileTags].sort().join(", ")}`,
      );
    }
  }
  assert.deepEqual([...new Set(problems)].sort(), []);
});

// ---------------------------------------------------------------------------
// The web bundle must never hold the whole catalog (messages/id.ts). The web
// build redirects every import of i18n/index.ts to i18n/runtime.ts
// (apps/web/vite-i18n-chunks.ts), so the graph below applies the same rule:
// an import that resolves to index.ts continues at runtime.ts.
// ---------------------------------------------------------------------------

const sharedSrc = path.resolve(import.meta.dirname, "../packages/shared/src");
const INDEX_FILE = path.join(sharedSrc, "i18n/index.ts");
const RUNTIME_FILE = path.join(sharedSrc, "i18n/runtime.ts");
const CATALOG_FILE = path.join(sharedSrc, "i18n/messages/id.ts");

// Statements that vanish at compile time: `import type ...` / `export type ...`.
const typeOnlyStatement =
  /\b(?:import|export)\s+type\b[^;'"]*?from\s*["'][^"']+["']/g;
const importPattern = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]+)["']/g;

test("web imports never reach the catalog file (messages/id.ts)", async () => {
  const sharedPackage = JSON.parse(
    await readFile(path.join(sharedSrc, "../package.json"), "utf8"),
  );
  const exportsMap = Object.fromEntries(
    Object.entries(sharedPackage.exports).map(([key, value]) => [
      key,
      typeof value === "string" ? value : (value.default ?? value.import),
    ]),
  );

  const webFiles = (await allSourceFiles(webSrc)).filter(
    (file) => !isMock(file),
  );
  const sharedFiles = await allSourceFiles(sharedSrc);
  const known = new Set([...webFiles, ...sharedFiles]);
  const source = new Map(
    await Promise.all(
      [...known].map(async (file) => [file, await readFile(file, "utf8")]),
    ),
  );

  const withExtension = (base) =>
    [
      base,
      base.replace(/\.(m?js)$/, ".ts"),
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ].find((candidate) => known.has(candidate));

  const resolveSpecifier = (from, specifier) => {
    let target;
    if (specifier.startsWith("@/"))
      target = withExtension(path.join(webSrc, specifier.slice(2)));
    else if (specifier.startsWith("."))
      target = withExtension(path.resolve(path.dirname(from), specifier));
    else if (specifier.startsWith("@starter/shared")) {
      const exported =
        exportsMap[`.${specifier.slice("@starter/shared".length)}`];
      if (exported)
        target = withExtension(path.resolve(sharedSrc, "..", exported));
    }
    return target === INDEX_FILE ? RUNTIME_FILE : target;
  };

  const edges = (file) => {
    const found = new Set();
    const code = source.get(file).replace(typeOnlyStatement, "");
    for (const match of code.matchAll(importPattern)) {
      const target = resolveSpecifier(file, match[1]);
      if (target && !isMock(target)) found.add(target);
    }
    return found;
  };

  // Walk from every web file, remembering how each file was reached.
  const parent = new Map(webFiles.map((file) => [file, null]));
  const queue = [...webFiles];
  while (queue.length) {
    const file = queue.shift();
    for (const next of edges(file))
      if (!parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
  }

  const chain = [];
  for (
    let file = CATALOG_FILE;
    parent.has(file) && file;
    file = parent.get(file)
  )
    chain.unshift(path.relative(path.resolve(sharedSrc, "../.."), file));
  assert.ok(
    !parent.has(CATALOG_FILE) && !parent.has(INDEX_FILE),
    `the web graph reaches the whole catalog: ${chain.join(" -> ")}`,
  );

  // The redirect only works if the runtime offers every value web code asks
  // of `@starter/shared/i18n`.
  const runtime = await import("../packages/shared/src/i18n/runtime.ts");
  const clause =
    /(?<!\btype\s)\bimport\s*\{([^}]*)\}\s*from\s*["']@starter\/shared\/i18n(?:\/runtime)?["']/g;
  const missing = [];
  for (const file of webFiles)
    for (const match of source.get(file).matchAll(clause))
      for (const entry of match[1].split(",")) {
        const name = entry.trim();
        if (!name || name.startsWith("type ")) continue;
        const imported = name.split(/\s+as\s+/)[0];
        if (!(imported in runtime))
          missing.push(
            `${path.relative(webSrc, file)} imports ${imported}, which runtime.ts does not export`,
          );
      }
  assert.deepEqual(missing, []);
});
