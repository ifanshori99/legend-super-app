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
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@/components/i18n": "export const useT = () => (key) => key;",
      "@/components/theme-scope":
        "export const ThemeScope = ({children}) => children;",
      "@/components/ui/badge": "export const Badge = ({children}) => children;",
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
  assert.match(html, /<p class="[^"]*type-title[^"]*">Expo<\/p>/);
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
