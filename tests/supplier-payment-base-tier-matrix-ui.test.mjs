// legend-98etn: the approval matrix screen shows SUPPLIER_PAYMENT_BASE_TIER_REQUIRED
// beside the supplier_payment row (not only in the top alert), and clears it when
// that row is edited or a new save starts. The web package has no DOM test
// runtime, so this renders the page with react-dom/server through a tiny
// stateful hooks shim: state survives between renders and each render is the
// "screen after the user's action". Written from the brief, not the implementation.
//   node --test tests/supplier-payment-base-tier-matrix-ui.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const i18nUrl = new URL("../packages/shared/src/i18n/index.ts", import.meta.url)
  .href;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const CODE = "SUPPLIER_PAYMENT_BASE_TIER_REQUIRED";
const TEXT =
  "Pembayaran supplier wajib punya tingkat dasar: tingkat 1 untuk semua nominal (batas 0). Tambahkan tingkat 1 dengan batas 0, supaya satu orang tidak bisa membayar supplier sendirian.";
const ROLE = "11111111-1111-4111-8111-111111111111";

const world = (globalThis.__bt = {
  React,
  cells: [],
  index: 0,
  buttons: [],
  saveError: null,
  mutations: [],
});

const uiNames = {
  "@/components/ui/badge": ["Badge"],
  "@/components/ui/card": ["Card", "CardShell"],
  "@/components/ui/feedback-state": ["ErrorState"],
  "@/components/ui/input": ["Input"],
  "@/components/ui/money": ["Money"],
  "@/components/ui/select": [
    "Select",
    "SelectContent",
    "SelectItem",
    "SelectTrigger",
    "SelectValue",
  ],
  "@/components/ui/skeleton": ["Skeleton"],
};

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromWeb = context.parentURL?.startsWith(webRoot.href);
    if (fromWeb && specifier === "react")
      return {
        url: stub(`const B = globalThis.__bt;
          export const useState = (init) => {
            const i = B.index++;
            if (!(i in B.cells)) B.cells[i] = typeof init === "function" ? init() : init;
            const set = (next) => { B.cells[i] = typeof next === "function" ? next(B.cells[i]) : next; };
            return [B.cells[i], set];
          };
          export const createElement = B.React.createElement;
          export const Fragment = B.React.Fragment;
          export const useMemo = B.React.useMemo;
          export const useRef = B.React.useRef;`),
        shortCircuit: true,
      };
    if (!fromWeb) return nextResolve(specifier, context);
    if (specifier === "@/components/i18n")
      return {
        url: stub(`import { createTranslator } from ${JSON.stringify(i18nUrl)};
          const t = createTranslator(); export const useT = () => t;`),
        shortCircuit: true,
      };
    if (specifier === "@/components/ui/button")
      return {
        url: stub(`const B = globalThis.__bt;
          const text = (c) => [c].flat(9).filter((x) => typeof x === "string").join("");
          export const Button = ({ children, onClick, disabled, loading, variant, size, ...rest }) => {
            B.buttons.push({ label: rest["aria-label"] ?? text(children), onClick, disabled });
            return B.React.createElement("button", { disabled: disabled || undefined }, children);
          };`),
        shortCircuit: true,
      };
    if (specifier === "@/components/ui/toast")
      return {
        url: stub("export const useToast = () => () => {};"),
        shortCircuit: true,
      };
    if (specifier === "@/lib/areas/guard")
      return {
        url: stub("export const holdsAny = () => true;"),
        shortCircuit: true,
      };
    if (uiNames[specifier])
      return {
        url: stub(`const R = globalThis.__bt.React;
          const node = ({ children }) => R.createElement("div", null, children);
          ${uiNames[specifier].map((n) => `export const ${n} = node;`).join("\n")}`),
        shortCircuit: true,
      };
    if (specifier === "lucide-react")
      return {
        url: stub(
          ["CircleAlert", "Plus", "ShieldCheck", "Trash2"]
            .map((n) => `export const ${n} = () => null;`)
            .join("\n"),
        ),
        shortCircuit: true,
      };
    if (specifier === "../hooks")
      return {
        url: stub(`const B = globalThis.__bt;
          export const useApprovalMatrix = () => ({ isPending: false, isError: false, data: { data: B.policies } });
          export const useRoles = () => ({ isPending: false, isError: false, data: { data: B.roles } });
          export const useReplaceApprovalMatrix = () => ({
            isPending: false,
            isError: B.saveError !== null,
            error: B.saveError,
            mutate: (body, opts) => { B.mutations.push({ body, opts }); },
          });`),
        shortCircuit: true,
      };
    if (specifier === "./access-shell")
      return {
        url: stub(
          `export const AccessPage = ({ children }) => globalThis.__bt.React.createElement("div", null, children);`,
        ),
        shortCircuit: true,
      };
    // Extensionless relative / alias imports inside the web sources.
    const base = specifier.startsWith("@/")
      ? new URL(specifier.slice(2), webRoot)
      : specifier.startsWith(".")
        ? new URL(specifier, context.parentURL)
        : null;
    if (base) {
      const path = fileURLToPath(base);
      const suffix = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].find(
        (s) =>
          existsSync(`${path}${s}`) &&
          !path.endsWith("/") &&
          (s !== "" || /\.\w+$/.test(path)),
      );
      if (suffix !== undefined)
        return nextResolve(pathToFileURL(`${path}${suffix}`).href, context);
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
after(() => {
  hook.deregister();
  delete globalThis.__bt;
});

const { ApprovalMatrixPage } =
  await import("../apps/web/src/features/ws01-access/components/approval-matrix-page.tsx");
const { ApiError } = await import("../apps/web/src/lib/api/errors.ts");

world.roles = [
  {
    id: ROLE,
    name: "Finance",
    isTemplate: true,
    templateKey: "finance",
    permissions: [],
  },
];
world.policies = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    actionType: "supplier_payment",
    thresholdIdr: 5_000_000,
    approverRoleId: ROLE,
    levels: 1,
    requiresDistinctActor: true,
  },
];

function render() {
  world.index = 0;
  world.buttons = [];
  return renderToStaticMarkup(
    React.createElement(ApprovalMatrixPage, { access: {} }),
  );
}
const button = (label) => world.buttons.find((b) => b.label === label);
const rowError = (html) =>
  /<p[^>]*role="alert"[^>]*data-testid="approval-row-error-supplier_payment"[^>]*>([^<]*)<\/p>|<p[^>]*data-testid="approval-row-error-supplier_payment"[^>]*role="alert"[^>]*>([^<]*)<\/p>/.exec(
    html,
  );

test("the base-tier error shows beside the supplier_payment row, once, and clears on edit or a new save", () => {
  const first = render();
  assert.ok(!first.includes(TEXT), "no error before any save");
  const save =
    button("Simpan matriks") ??
    world.buttons.find((b) => /^Simpan/.test(b.label));
  assert.ok(
    save,
    `save button not found in ${JSON.stringify(world.buttons.map((b) => b.label))}`,
  );

  // Save -> API answers 422 SUPPLIER_PAYMENT_BASE_TIER_REQUIRED.
  save.onClick();
  assert.equal(world.mutations.length, 1);
  const error = new ApiError(422, CODE, "server said something else");
  world.saveError = error;
  world.mutations.at(-1).opts.onError(error);

  const shown = render();
  const match = rowError(shown);
  assert.ok(match, "row error element with data-testid is missing");
  assert.equal((match[1] ?? match[2]).replaceAll("&#x27;", "'"), TEXT);
  assert.equal(
    shown.split(TEXT).length - 1,
    1,
    "text must appear once, beside the row",
  );

  // Editing that row clears it.
  const add = world.buttons.find((b) => /^Tambah tingkat/i.test(b.label));
  assert.ok(add, "add-tier button not found");
  add.onClick();
  world.saveError = null;
  assert.ok(!render().includes(TEXT), "row edit must clear the error");

  // A new save clears it too (error returns only if the API refuses again).
  world.saveError = error;
  world.mutations.at(-1).opts.onError(error);
  assert.ok(rowError(render()));
  world.buttons.find((b) => /^Simpan/.test(b.label)).onClick();
  world.saveError = null;
  assert.ok(!render().includes(TEXT), "a new save clears the error");
});

test("other save errors still use the top alert and no row error", () => {
  world.saveError = new ApiError(409, "CONFLICT", "x");
  const html = render();
  assert.ok(!rowError(html));
  assert.ok(html.includes('role="alert"'));
  world.saveError = null;
});
