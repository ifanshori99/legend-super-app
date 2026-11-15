import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { roleTemplate } from "../packages/shared/src/access/index.ts";

const require = createRequire(import.meta.url);
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = require("typescript");

function load(relative, dependencies) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unstubbed dependency ${name}`);
  }, exports);
  return exports;
}

test("legend-mm029 recovery verifies PIN with an emergency session and never creates a POS session", async () => {
  const calls = [];
  let pending;
  const answer = {
    data: { user: { id: "staff", displayName: "Rina" }, outletId: "outlet" },
  };
  const api = Object.fromEntries(
    [
      "startEmergencySessionCall",
      "startPosSessionCall",
      "verifyStaffPinCall",
      "endPosSessionCall",
    ].map((name) => [
      name,
      async (input) => {
        calls.push({ name, input });
        return answer;
      },
    ]),
  );
  const { usePinSession } = load(
    "../apps/web/src/features/ws01-device-pin/use-pin-session.ts",
    {
      react: {
        useCallback: (fn) => fn,
        useState: (value) => [value, () => {}],
      },
      "@tanstack/react-query": {
        useMutation: ({ mutationFn }) => ({
          mutate: (input, callbacks) => {
            pending = mutationFn(input).then(callbacks.onSuccess);
          },
          reset() {},
          isPending: false,
        }),
      },
      "@starter/shared/core": {
        userIdSchema: { safeParse: (data) => ({ success: true, data }) },
      },
      "@/components/i18n": { useT: () => (key) => key },
      "@/lib/api/errors": { ApiError: class extends Error {} },
      "./api.ts": api,
      "./use-pin-lock.ts": {
        usePinLock: () => ({
          recordSuccess() {},
          failedAttempts: 0,
          locked: false,
        }),
      },
    },
  );
  const hook = usePinSession({
    mode: "emergency-session",
    userId: "staff",
    onVerified() {},
  });
  hook.submit("582914");
  await pending;
  assert.deepEqual(
    calls.map((call) => call.name),
    ["startEmergencySessionCall"],
  );
  assert.deepEqual(calls[0].input, { userId: "staff", pin: "582914" });
});

test("legend-mm029 emergency PIN caller sends staffUserId to the receiver endpoint without storing a cashier token", async () => {
  const calls = [];
  const writes = [];
  const dependencies = Object.fromEntries(
    [
      "@starter/shared/identity",
      "@starter/shared/access/override",
      "@starter/shared/api",
      "@starter/shared/core",
      "@starter/shared/pos/acting-staff",
      "@starter/shared/facility",
      "zod",
    ].map((name) => [name, webRequire(name)]),
  );
  const { startEmergencySessionCall } = load(
    "../apps/web/src/features/ws01-device-pin/api.ts",
    {
      ...dependencies,
      "@/lib/api/endpoint": {
        callEndpoint: async (endpoint, input, options) => {
          calls.push({ endpoint, input, options });
          return {
            data: {
              user: { id: "staff", displayName: "Rina" },
              outletId: "outlet",
            },
          };
        },
      },
      "./storage.ts": {
        writeActingStaffToken: (value) => writes.push(value),
        releaseActingStaffToken() {},
      },
    },
  );
  assert.equal(typeof startEmergencySessionCall, "function");
  await startEmergencySessionCall({ userId: "staff", pin: "582914" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint.method, "POST");
  assert.equal(calls[0].endpoint.path, "/api/emergency/sessions");
  assert.deepEqual(calls[0].input.body, {
    staffUserId: "staff",
    pin: "582914",
  });
  assert.deepEqual(writes, []);
});

function route(relative, permissions) {
  let options;
  const stubRoute = {
    useRouteContext: () => ({ access: { permissions } }),
    useSearch: () => ({}),
  };
  const dependencies = {
    "@tanstack/react-router": {
      createFileRoute: () => (value) => {
        options = value;
        return stubRoute;
      },
      Outlet: "outlet",
      notFound: () => new Error("not found"),
    },
    zod: webRequire("zod"),
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: "fragment",
    },
    "@/features/facility-staff/components/panic-alert-layer": {
      PanicAlertLayer: "panic-layer",
    },
    "@/features/facility-staff/components/panic-push-control": {
      PanicPushControl: "panic-push-control",
    },
    "@/features/facility-staff/components/emergency-screen": {
      EmergencyScreen: "emergency-screen",
    },
    "@starter/shared/i18n": { createTranslator: () => (key) => key },
    "@/lib/areas/guard": {
      evaluateGuard: (guard, access) => ({
        status: guard.anyOf.some((permission) =>
          access.permissions.includes(permission),
        )
          ? "allowed"
          : "denied",
      }),
    },
  };
  load(relative, dependencies);
  return options;
}

function containsPanic(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsPanic);
  return node.type === "panic-layer" || containsPanic(node.props?.children);
}

for (const key of ["outlet_manager", "general_manager", "cashier"]) {
  test(`legend-oi7ub ${key} mounts and opens emergency only with its default respond permission`, () => {
    const permissions = roleTemplate(key).permissions;
    const allowed = permissions.includes("facility.emergency.respond");
    const layout = route(
      "../apps/web/src/routes/_ops/fasilitas.tsx",
      permissions,
    );
    assert.equal(
      containsPanic(layout.component()),
      allowed,
      "receiver layer follows respond permission",
    );
    const emergency = route(
      "../apps/web/src/routes/_ops/fasilitas.darurat.tsx",
      permissions,
    );
    const enter = () =>
      emergency.beforeLoad({ context: { access: { permissions } } });
    if (allowed) assert.doesNotThrow(enter);
    else assert.throws(enter);
    const icons = Object.fromEntries(
      ["ClipboardList", "ShieldAlert", "Siren", "SprayCan"].map((name) => [
        name,
        name,
      ]),
    );
    const { default: nav } = load(
      "../apps/web/src/features/facility-staff/nav.ts",
      { "lucide-react": icons },
    );
    const tab = nav.find((item) => item.to === "/fasilitas/darurat");
    assert.equal(
      tab.anyPermission.some((permission) => permissions.includes(permission)),
      allowed,
    );
    assert.deepEqual(
      nav.find((item) => item.to === "/fasilitas/insiden").anyPermission,
      ["facility.access.assist"],
    );
  });
}
