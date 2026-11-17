import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

export function componentHarness(stubs) {
  globalThis.__844React = React;
  globalThis.__844Data = {};
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "react" &&
        context.parentURL?.startsWith(webRoot.href) &&
        context.parentURL.endsWith(".tsx")
      ) {
        return {
          url: stub(`const R = globalThis.__844React;
            export const createElement = R.createElement;
            export const useState = (value) => R.useState(globalThis.__844Data.mode && value === "equal" ? globalThis.__844Data.mode : globalThis.__844Data.selected && Array.isArray(value) ? globalThis.__844Data.selected : globalThis.__844Data.target && value === "" ? globalThis.__844Data.target : value);
            export const useMemo = R.useMemo;
            export const useRef = R.useRef;
            export const useCallback = R.useCallback;
            // Static markup never runs effects; a test opts in with data.runEffects to
            // exercise effect-wired refs (kds realtime resume, legend-t0m89).
            export const useEffect = (effect) => { if (globalThis.__844Data.runEffects) effect(); };
            export const useSyncExternalStore = R.useSyncExternalStore;`),
          shortCircuit: true,
        };
      }
      const replacement = stubs(specifier, context.parentURL);
      if (replacement !== undefined)
        return { url: stub(replacement), shortCircuit: true };
      if (specifier === "@/components/i18n")
        return {
          url: stub(
            "export const useT = () => (key, args) => `${key} ${JSON.stringify(args ?? {})}`;",
          ),
          shortCircuit: true,
        };
      if (specifier === "@/lib/tenant-context")
        return {
          url: stub(
            'export const useTenantContext = () => ({ outlet: { id: "outlet" } });',
          ),
          shortCircuit: true,
        };
      if (specifier.startsWith("@/components/ui/")) {
        const exports = [
          "Button",
          "Badge",
          "Card",
          "Checkbox",
          "Dialog",
          "DialogContent",
          "DialogDescription",
          "DialogFooter",
          "DialogHeader",
          "DialogTitle",
          "Input",
          "Label",
          "Money",
          "Select",
          "SelectContent",
          "SelectItem",
          "SelectTrigger",
          "SelectValue",
          "Table",
          "TableBody",
          "TableCell",
          "TableHead",
          "TableHeader",
          "TableRow",
          "DataTableShell",
          "ErrorState",
          "EmptyState",
          "Skeleton",
          "StatusBand",
          "SegmentedControl",
        ];
        return {
          url: stub(`const R = globalThis.__844React;
            const node = ({children, amount, options, disabled, ...props}) => { if (props.onClick) globalThis.__844Events.push({onClick: props.onClick, disabled}); return R.createElement("div", {"data-disabled": disabled || undefined}, children, amount ?? null, options?.map(option => R.createElement("span", {key: option.value}, option.label, " ", option.count))); };
            ${exports.map((name) => `export const ${name} = node;`).join("\n")}
            export const useToast = () => () => {};`),
          shortCircuit: true,
        };
      }
      if (specifier.startsWith("@/")) {
        const target = new URL(specifier.slice(2), webRoot);
        const suffix = ["", ".tsx", ".ts"].find((extension) =>
          existsSync(`${fileURLToPath(target)}${extension}`),
        );
        if (suffix !== undefined)
          return nextResolve(`${target.href}${suffix}`, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(webRoot.href) && url.endsWith(".tsx")) {
        const source = ts.transpileModule(
          readFileSync(new URL(url), "utf8").replaceAll(
            "import.meta.env.VITE_API_MOCK",
            '"false"',
          ),
          {
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              jsx: ts.JsxEmit.ReactJSX,
              target: ts.ScriptTarget.ES2022,
            },
          },
        ).outputText;
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  return {
    render(Component, props = {}, data = {}) {
      globalThis.__844Data = data;
      globalThis.__844Events = [];
      return renderToStaticMarkup(React.createElement(Component, props));
    },
    lastAction() {
      return globalThis.__844Events.at(-1);
    },
    close() {
      hook.deregister();
      delete globalThis.__844React;
      delete globalThis.__844Data;
      delete globalThis.__844Events;
    },
  };
}
