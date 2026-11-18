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
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "@tanstack/react-router":
        "export const useLocation = () => ({pathname: globalThis.__edgeTestPath,searchStr:null,href:globalThis.__edgeTestPath}); export const useParams = () => ({}); export const useRouteContext = () => null; export const Link = ({children}) => children;",
      "@/components/i18n": "export const useT = () => (key) => key;",
      "@/components/ui/button":
        "export const Button = ({children}) => children;",
      "@/lib/use-online": "export const useOnline = () => true;",
      "../hooks.ts":
        "export const useEdgeStatus = () => ({isError:true,error:new Error('unreachable')});",
      "../use-now.ts":
        "export const useHydrated = () => true; export const useNowMs = () => 0;",
      "./catalog-sales-notice.tsx":
        "export const CatalogSalesNotice = () => null;",
      "./training-mode-watermark.tsx":
        "export const TrainingModeWatermark = () => null;",
    };
    const frameStubs = {
      "@/lib/areas/definitions":
        'export const AREAS = {platform:{shell:"management",nameKey:"platform"},operasional:{shell:"operations",nameKey:"operasional"}};',
      "@/lib/areas/nav": "export const buildAreaNav = () => [];",
      "@/lib/areas/nav-registry": "export const registeredNav = [];",
      "@/lib/areas/guard": "export const holdsAny = () => false;",
      "@/lib/areas/outlet-selection":
        'export const kelolaUsesOutletContext = () => false; export const noOutletNext = () => "home"; export const outletChoice = () => "one"; export const outletPickPending = () => false; export const readSavedOutletId = () => null; export const resolveSelectedOutlet = () => null; export const saveOutletId = () => {};',
      "@/lib/api/mock-flag": "export const API_MOCK = false;",
      "@/lib/mock/tenant-context":
        "export const resolveMockOutlets = () => []; export const resolveMockTenantContext = () => null; export const savedOutletCutoff = () => null;",
      "@/features/ws01-org/outlet-store":
        'export const ORG_OUTLET_STORE_EVENT = "changed";',
      "@/lib/tenant-context":
        'export const TenantProvider = ({children}) => children; export const useTenantContext = () => ({brandName:"test"});',
      "@/features/ws02-edge/hooks":
        "export const useCloudConnection = () => false;",
      "@/components/layout/area-icons": "export const AREA_ICONS = {};",
      "@/components/layout/outlet-picker":
        "export const OutletPicker = ({children}) => children ?? null; export const OutletList = ({children}) => children ?? null;",
    };
    const frameComponents = {
      "@/components/layout/area-gate-screen": "AreaGateScreen",
      "@/features/ws05-notifications/components/push-auto-register":
        "PushAutoRegister",
      "@/components/layout/router-link": "RouterShellLink",
      "@/components/layout/theme-toggle": "ThemeToggle",
      "@/components/shells/customer-shell": "CustomerShell",
      "@/components/shells/management-shell": "ManagementShell",
      "@/components/shells/operations-shell": "OperationsShell",
      "@/components/sign-out-button": "SignOutButton",
      "@/components/ui/feedback-state": "EmptyState",
      "@/components/ui/skeleton": "Skeleton",
      "@/features/ws03-qr-order/components/table-frame": "TableCustomerFrame",
      "@/features/ws01-auth/components/idle-session-warning":
        "IdleSessionWarning",
      "@/features/ws01-approvals/components/inbox-badge": "ApprovalInboxBadge",
      "@/features/ws01-support-access/components/session-banner":
        "SupportSessionBar",
      "@/features/ws01-support-access/read-only": "SupportReadOnlyProvider",
    };
    if (specifier in frameStubs)
      return { url: stub(frameStubs[specifier]), shortCircuit: true };
    if (specifier in frameComponents)
      return {
        url: stub(
          `export const ${frameComponents[specifier]} = ({children}) => children ?? null;`,
        ),
        shortCircuit: true,
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

const { AreaFrame } = await import(
  new URL("components/layout/area-frame.tsx", webRoot).href
);
function renderAt(path) {
  globalThis.__edgeTestPath = path;
  return renderToStaticMarkup(
    React.createElement(
      AreaFrame,
      {
        area: path.startsWith("/platform") ? "platform" : "operasional",
        access: { outlets: [], authenticated: true },
        gate: { status: "allowed" },
        session: null,
      },
      "Content",
    ),
  );
}

test("failed edge probe does not show an offline banner in platform", () => {
  assert.doesNotMatch(renderAt("/platform/tenants"), /data-edge-banner=/);
});

test("failed edge probe still shows the unknown banner in an outlet", () => {
  assert.match(renderAt("/operasional/pos"), /data-edge-banner="unknown"/);
});
