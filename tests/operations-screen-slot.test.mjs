import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// bead legend-3wyd: a kitchen screen names itself in the OperationsShell
// status bar and puts its actions there, through a route-fed slot. Effects do
// not run in SSR, so the slot store is tested as pure functions and the shell
// is rendered with title/actions props.
const webRoot = new URL("../apps/web/src/", import.meta.url);
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const ts = rootRequire("typescript");
globalThis.__stubReact = React;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@/components/i18n": "export const useT = () => (key) => key;",
      "@/components/theme-scope":
        "export const ThemeScope = ({children}) => children;",
      "@/components/ui/badge": "export const Badge = ({children}) => children;",
      "@/components/ui/button":
        'const h = globalThis.__stubReact.createElement; export const Button = ({children, ...p}) => h("button", p, children);',
      "@/components/ui/sheet":
        'const h = globalThis.__stubReact.createElement; const box = (tag) => ({children, ...p}) => h(tag, p, children); export const Sheet = box("div"); export const SheetTrigger = ({children}) => children; export const SheetContent = box("section"); export const SheetHeader = box("header"); export const SheetTitle = box("h2"); export const SheetDescription = box("p"); export const SheetClose = ({children}) => children;',
      "@/components/ui/select":
        "const n = () => null; export const Select = n, SelectContent = n, SelectItem = n, SelectTrigger = n, SelectValue = n;",
      "@/lib/tenant-context":
        'export const useTenantContext = () => ({outlet:null,station:null}); export const useOutletClock = () => ({timeZone:"Asia/Jakarta",businessDayCutoff:"04:00"});',
    };
    if (specifier in stubs)
      return { url: stub(stubs[specifier]), shortCircuit: true };
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

const screen = await import(
  new URL("components/shells/operations-screen.tsx", webRoot).href
);
const { OperationsShell } = await import(
  new URL("components/shells/operations-shell.tsx", webRoot).href
);
const { OutletList } = await import(
  new URL("components/layout/outlet-picker.tsx", webRoot).href
);
const h = React.createElement;

test("the slot store registers a screen and clears it on unmount", () => {
  const action = h("button", null, "Muat ulang");
  let state = screen.EMPTY_OPERATIONS_SCREEN;
  state = screen.operationsScreenReducer(state, {
    type: "set",
    id: "a",
    title: "Expo",
    actions: action,
  });
  assert.equal(state.title, "Expo");
  assert.equal(state.actions, action);
  state = screen.operationsScreenReducer(state, { type: "clear", id: "a" });
  assert.deepEqual(state, screen.EMPTY_OPERATIONS_SCREEN);
});

test("a late cleanup of an old screen does not wipe the new screen", () => {
  let state = screen.EMPTY_OPERATIONS_SCREEN;
  state = screen.operationsScreenReducer(state, {
    type: "set",
    id: "old",
    title: "Expo",
    actions: null,
  });
  state = screen.operationsScreenReducer(state, {
    type: "set",
    id: "new",
    title: "Pickup",
    actions: null,
  });
  state = screen.operationsScreenReducer(state, { type: "clear", id: "old" });
  assert.equal(state.title, "Pickup");
});

test("the area name is the title when no screen registered one", () => {
  assert.equal(
    screen.resolveOperationsTitle(screen.EMPTY_OPERATIONS_SCREEN, "Dapur"),
    "Dapur",
  );
  assert.equal(
    screen.resolveOperationsTitle(
      { id: "a", title: "Expo", actions: null },
      "Dapur",
    ),
    "Expo",
  );
  assert.equal(
    screen.resolveOperationsTitle(
      { id: "a", title: "", actions: null },
      "Dapur",
    ),
    "Dapur",
  );
});

test("without a provider the hook is a no-op and does not throw", () => {
  function Probe() {
    screen.useOperationsScreen({ title: "Expo", actions: null });
    return h("p", null, "ok");
  }
  assert.equal(renderToStaticMarkup(h(Probe)), "<p>ok</p>");
});

test("with a provider the first paint still shows the area title", () => {
  function Probe() {
    screen.useOperationsScreen({ title: "Expo", actions: null });
    return null;
  }
  function Frame() {
    const current = screen.useOperationsScreenValue();
    return h(
      OperationsShell,
      {
        title: screen.resolveOperationsTitle(current, "Dapur"),
        online: true,
        actions: current.actions,
      },
      null,
    );
  }
  const html = renderToStaticMarkup(
    h(screen.OperationsScreenProvider, null, h(Probe), h(Frame)),
  );
  assert.match(html, /Dapur/);
});

test("the shell renders the screen title and the slot actions", () => {
  const html = renderToStaticMarkup(
    h(
      OperationsShell,
      {
        title: "Expo",
        online: true,
        actions: h("button", { "data-slot-action": "refresh" }, "Muat ulang"),
      },
      "Body",
    ),
  );
  assert.match(html, /<p[^>]*class="[^"]*type-title[^"]*"[^>]*>Expo<\/p>/);
  assert.match(html, /data-slot-action="refresh"/);
});

test("kitchen screens hand their title and actions to the shell slot", () => {
  const read = (path) => readFileSync(new URL(path, webRoot), "utf8");
  const frame = read("components/layout/area-frame.tsx");
  assert.match(frame, /OperationsScreenProvider/);
  assert.match(frame, /resolveOperationsTitle\(/);
  const expo = read("features/ws04-expo/components/screen-header.tsx");
  assert.match(expo, /useOperationsScreen\(/);
  assert.match(expo, /<h1 className="sr-only">/);
  const kds = read("features/ws04-kds/components/kds-page.tsx");
  assert.match(kds, /useOperationsScreen\(/);
  assert.match(kds, /<h1 className="sr-only">\{t\("kds\.title"\)\}<\/h1>/);
});

test("the shell without an outlet picker still shows the title and actions", () => {
  const html = renderToStaticMarkup(
    h(
      OperationsShell,
      {
        title: "Pickup",
        online: false,
        actions: h("button", { "data-slot-action": "refresh" }, "Muat ulang"),
      },
      "Body",
    ),
  );
  assert.match(html, />Pickup<\/p>/);
  assert.match(html, /data-slot-action="refresh"/);
  assert.doesNotMatch(html, /role="radiogroup"/);
});

test("an outlet sheet control renders behind a labelled outlet button", () => {
  const html = renderToStaticMarkup(
    h(
      OperationsShell,
      {
        title: "Expo",
        online: true,
        outlet: "Legend Kopi Panjang Sekali Cabang Tengah",
        station: "Bar",
        staffName: "Sari",
        outletControl: h("div", { "data-desktop-picker": "1" }),
        outletSheetControl: h("div", { role: "radiogroup" }),
      },
      "Body",
    ),
  );
  assert.match(html, /aria-label="area\.ops\.outletButton"/);
  assert.match(html, /<h2[^>]*>area\.ops\.sheetTitle<\/h2>/);
  assert.match(html, /role="radiogroup"/);
  // Full outlet, station and staff sit in the sheet; the phone subtitle names
  // the outlet next to the station.
  assert.match(html, /<dd[^>]*>Legend Kopi Panjang Sekali Cabang Tengah<\/dd>/);
  assert.match(html, /<dd[^>]*>Bar<\/dd>/);
  assert.match(html, /<dd[^>]*>Sari<\/dd>/);
  assert.match(
    html,
    /sm:hidden[^>]*>Legend Kopi Panjang Sekali Cabang Tengah · Bar<\/p>/,
  );
  // Desktop keeps the picker; the staff name leaves the phone bar.
  assert.match(html, /data-desktop-picker="1"/);
  assert.match(html, /max-sm:hidden[^>]*>Sari<\/span>/);
});

test("the phone status bar is a 56px minimum row", () => {
  const html = renderToStaticMarkup(
    h(OperationsShell, { title: "Expo", online: true }, "Body"),
  );
  const header = html.match(/<header[^>]*class="([^"]*)"/)?.[1] ?? "";
  // legend-1082: min-h-14, so a two-line phone title grows the bar instead of clipping.
  assert.match(header, /max-sm:min-h-14/);
  assert.match(header, /max-sm:py-1/);
  assert.doesNotMatch(header, /(^|\s)flex-wrap/);
  assert.match(header, /sm:min-h-16/);
  // Round 2: phone clock, subtitle and cluster gap stay compact (Badge is stubbed here).
  assert.match(html, /max-sm:text-sm/);
  assert.match(html, /text-sm leading-4 text-muted-foreground sm:hidden/);
  assert.match(html, /max-sm:gap-1\.5/);
  // Without a picker or actions no empty wrapper shifts the desktop clock.
  const bar = html.match(/<header[\s\S]*<\/header>/)?.[0] ?? "";
  assert.doesNotMatch(
    bar,
    /class="flex items-center gap-2 sm:min-w-0 sm:flex-wrap"/,
  );
  assert.doesNotMatch(bar, /class="flex min-w-0 flex-wrap items-center gap-2"/);
});

test("the sheet outlet list marks the active outlet without radio roles", () => {
  const html = renderToStaticMarkup(
    h(OutletList, {
      outlets: [
        { id: "o1", name: "Cabang Satu" },
        { id: "o2", name: "Cabang Dua" },
      ],
      value: "o2",
      onChange: () => {},
    }),
  );
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="area\.outletPicker"/);
  assert.match(html, /<button[^>]*aria-current="true"[^>]*>[\s\S]*Cabang Dua/);
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
  assert.doesNotMatch(html, /role="radio/);
  assert.doesNotMatch(html, /aria-checked/);
});
