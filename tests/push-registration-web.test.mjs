// legend-ofq4f D5 (web side of push registration + X-Device-Token) and the web
// items 1, 6 and 7 of the architect findings in docs/briefs/791-panic-architect-findings.md.
// Written from docs/briefs/ofq4f-push-registration.md, not from the engineer's
// notes. Module loading follows tests/panic-recovery-gate.test.mjs.
//
// ASSUMPTIONS where the brief is silent:
//  - Device token store exports getDeviceToken / setDeviceToken /
//    clearDeviceToken in apps/web/src/lib/device-token-store.ts (brief: "get/set/clear").
//  - The header is sent as "X-Device-Token"; header names compare case-insensitively.
//  - The dialog's new action and the facility control are not rendered here
//    (no DOM in node:test); they are checked through the i18n catalog text and
//    through what the code imports and calls.
//  - Item 7 is checked as "the emergency success navigation to /fasilitas
//    carries a search object" because the brief fixes the behaviour (keep the
//    origin search params, internal path only), not the prop name.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { registerHooks } from "node:module";
import { afterEach, describe, test } from "node:test";

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

const require = createRequire(import.meta.url);
const ts = require("typescript");
const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/** Transpile one source file to CommonJS and run it with controlled requires. */
function load(relative, dependencies, fallback = () => ({})) {
  const source = read(relative).replaceAll("import.meta.env", "({})");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    if (name in dependencies) return dependencies[name];
    return fallback(name);
  }, exports);
  return exports;
}

const storage = new Map();
function installBrowser() {
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = { localStorage };
  globalThis.localStorage = localStorage;
}
function removeBrowser() {
  delete globalThis.window;
  delete globalThis.localStorage;
  storage.clear();
}
afterEach(removeBrowser);

const STORE = "apps/web/src/lib/device-token-store.ts";

describe("legend-ofq4f device token store", () => {
  test("keeps the token under legend.device.token in this browser and forgets it on clear", () => {
    installBrowser();
    const store = load(STORE, {});
    assert.equal(store.getDeviceToken(), null);
    store.setDeviceToken("tok-123");
    assert.equal(storage.get("legend.device.token"), "tok-123");
    assert.equal(store.getDeviceToken(), "tok-123");
    store.clearDeviceToken();
    assert.equal(store.getDeviceToken(), null);
    assert.equal(storage.has("legend.device.token"), false);
  });

  test("never throws and answers no token on the server or when storage is blocked", () => {
    const store = load(STORE, {});
    assert.equal(store.getDeviceToken(), null); // no window (SSR)
    assert.doesNotThrow(() => store.setDeviceToken("x"));
    assert.doesNotThrow(() => store.clearDeviceToken());
    globalThis.window = {
      localStorage: {
        getItem() {
          throw new Error("blocked");
        },
        setItem() {
          throw new Error("blocked");
        },
        removeItem() {
          throw new Error("blocked");
        },
      },
    };
    assert.equal(store.getDeviceToken(), null);
    assert.doesNotThrow(() => store.setDeviceToken("x"));
    assert.doesNotThrow(() => store.clearDeviceToken());
  });
});

describe("legend-ofq4f apiFetch sends X-Device-Token (also architect 791 item 1)", () => {
  function apiFetchWith() {
    const storeExports = load(STORE, {});
    const dependencies = {
      "@tanstack/react-start": {
        createIsomorphicFn: () => ({
          server: () => ({ client: (fn) => fn }),
        }),
      },
      "@/lib/env": { API_URL: "https://api.example.test" },
      "@/lib/api/errors": {
        ApiError: class extends Error {},
        NETWORK_ERROR_MESSAGE: "network",
      },
      "@/lib/api/credentials": { bearerHeaderFor: () => ({}) },
      "@/lib/api/acting-staff": {
        ACTING_STAFF_HELD_MESSAGE: "held",
        actingStaffHeaderFor: () => ({}),
        handleActingStaffRejection() {},
      },
      "@starter/shared/pos/acting-staff": { ACTING_STAFF_ERROR_CODES: {} },
      "@/lib/api/upstream.server": {
        apiBaseUrl: () => "http://internal",
        forwardedHeaders: () => ({}),
        logUpstreamFailure() {},
      },
    };
    return load("apps/web/src/lib/api/client.ts", dependencies, (name) =>
      /device-token-store/.test(name) ? storeExports : {},
    ).apiFetch;
  }
  async function headersOf(path, method = "GET") {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push(
        Object.fromEntries(
          Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      );
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await apiFetchWith()(path, { method });
    } finally {
      globalThis.fetch = realFetch;
    }
    return seen[0];
  }

  test("sends the stored token on a normal call and on the emergency session start", async () => {
    installBrowser();
    storage.set("legend.device.token", "tok-abc");
    assert.equal(
      (await headersOf("/api/notifications/push-key"))["x-device-token"],
      "tok-abc",
    );
    assert.equal(
      (await headersOf("/api/emergency/sessions", "POST"))["x-device-token"],
      "tok-abc",
    );
  });

  test("sends no header when this browser holds no token or on the server", async () => {
    installBrowser();
    assert.equal(
      (await headersOf("/api/notifications/push-key"))["x-device-token"],
      undefined,
    );
    storage.set("legend.device.token", "tok-abc");
    removeBrowser(); // SSR: no window
    assert.equal(
      (await headersOf("/api/notifications/push-key"))["x-device-token"],
      undefined,
    );
  });

  // Architect round v2 V5: the stored token is dropped only when the registry
  // says the TOKEN is bad (DEVICE_TOKEN_INVALID). Any other failure (e.g. an
  // inactive tenant answers UNAUTHORIZED) must leave it in place.
  async function failWith(status, code) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code, message: "no" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    try {
      await apiFetchWith()("/api/notifications/push-key");
      assert.fail("the call should have been rejected");
    } catch (error) {
      if (error?.code === "ERR_ASSERTION") throw error;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("forgets the stored token when the API answers DEVICE_TOKEN_INVALID", async () => {
    installBrowser();
    storage.set("legend.device.token", "tok-abc");
    await failWith(401, "DEVICE_TOKEN_INVALID");
    assert.equal(storage.has("legend.device.token"), false);
  });

  test("keeps the stored token on UNAUTHORIZED, FORBIDDEN and server errors", async () => {
    installBrowser();
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [500, "INTERNAL_ERROR"],
    ]) {
      storage.set("legend.device.token", "tok-abc");
      await failWith(status, code);
      assert.equal(
        storage.get("legend.device.token"),
        "tok-abc",
        `${status} ${code} must not drop the token`,
      );
    }
  });

  test("the emergency PIN call still goes through the shared API caller", () => {
    const source = read("apps/web/src/features/ws01-device-pin/api.ts");
    const call = source.slice(
      source.indexOf("export const startEmergencySessionCall"),
    );
    assert.match(call.split("\n\n")[0], /callEndpoint\(/);
  });
});

describe("legend-ofq4f push subscription input accepts an optional outlet", () => {
  test("outletId is optional and must be a valid outlet id", async () => {
    const { pushSubscriptionInputSchema } =
      await import("../packages/shared/src/notification/schemas.ts");
    const base = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: {
        p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
      deviceLabel: null,
    };
    assert.equal(pushSubscriptionInputSchema.safeParse(base).success, true);
    assert.equal(
      pushSubscriptionInputSchema.safeParse({
        ...base,
        outletId: "2b9e5a4e-6f77-4c7c-9f36-2f6a1d4c8e11",
      }).success,
      true,
    );
    assert.equal(
      pushSubscriptionInputSchema.safeParse({ ...base, outletId: "not-an-id" })
        .success,
      false,
    );
    // Strict: tenant and user still cannot be named by the client.
    assert.equal(
      pushSubscriptionInputSchema.safeParse({ ...base, tenantId: "x" }).success,
      false,
    );
  });
});

describe("legend-ofq4f device token dialog keeps the token on request", () => {
  const catalogs = readdirSync(
    new URL("../packages/shared/src/i18n/messages/", import.meta.url),
  )
    .map((file) => read(`packages/shared/src/i18n/messages/${file}`))
    .join("\n");

  test("offers 'Pakai di perangkat ini' from the message catalog", () => {
    assert.match(catalogs, /Pakai di perangkat ini/);
    assert.doesNotMatch(
      read(
        "apps/web/src/features/ws02-devices/components/device-token-dialog.tsx",
      ).replace(/^\s*\/\/.*$/gm, ""),
      /Pakai di perangkat ini/,
      "UI text comes from the catalog, not a literal",
    );
  });

  test("the action stores the token through the device token store", () => {
    const source = read(
      "apps/web/src/features/ws02-devices/components/device-token-dialog.tsx",
    );
    assert.match(source, /device-token-store/);
    assert.match(source, /\bsetDeviceToken\(/);
  });

  test("the facility alarm control text lives in the catalog", () => {
    assert.match(catalogs, /Aktifkan notifikasi alarm/);
  });
});

describe("legend-ofq4f sign-out revokes the push subscription first", () => {
  function signOutClick() {
    const calls = [];
    const recorder = (name) =>
      new Proxy(
        {},
        {
          get: (_target, prop) => async () => {
            calls.push(`${name}:${String(prop)}`);
          },
        },
      );
    const tree = [];
    const { SignOutButton } = load(
      "apps/web/src/components/sign-out-button.tsx",
      {
        react: { useState: (value) => [value, () => {}] },
        "react/jsx-runtime": {
          jsx: (type, props) => (tree.push({ type, props }), { type, props }),
          jsxs: (type, props) => (tree.push({ type, props }), { type, props }),
          Fragment: "fragment",
        },
        "@tanstack/react-router": {
          useRouter: () => ({ invalidate: async () => {} }),
          useNavigate: () => async () => {},
        },
        "lucide-react": { LogOut: "LogOut" },
        "@/components/ui/button": { Button: "Button" },
        "@/lib/auth-client": {
          authClient: {
            signOut: async () => {
              calls.push("signOut");
              return {};
            },
          },
        },
        "@/lib/api/acting-staff": { endActingStaffMode() {} },
      },
      (name) => (/notifications|push/i.test(name) ? recorder(name) : {}),
    );
    SignOutButton();
    const button = tree.find((node) => node.type === "Button");
    return { click: () => button.props.onClick(), calls };
  }

  test("a push cleanup call happens before authClient.signOut", async () => {
    const { click, calls } = signOutClick();
    await click();
    const signOutAt = calls.indexOf("signOut");
    assert.notEqual(signOutAt, -1, "sign-out still happens");
    assert.ok(
      calls
        .slice(0, signOutAt)
        .some((call) => /notifications|push/i.test(call)),
      `push cleanup must run before signOut, saw ${JSON.stringify(calls)}`,
    );
  });
});

describe("legend-ofq4f /fasilitas offers alarm notifications to receivers only", () => {
  function layoutTypes(permissions) {
    let options;
    const stubRoute = {
      useRouteContext: () => ({ access: { permissions } }),
      useSearch: () => ({}),
    };
    const types = [];
    load(
      "apps/web/src/routes/_ops/fasilitas.tsx",
      {
        "@tanstack/react-router": {
          createFileRoute: () => (value) => {
            options = value;
            return stubRoute;
          },
          Outlet: "outlet",
        },
        zod: createRequire(
          new URL("../apps/web/package.json", import.meta.url),
        )("zod"),
        "react/jsx-runtime": {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: "fragment",
        },
        "@/lib/areas/guard": {
          evaluateGuard: (guard, access) => ({
            status: guard.anyOf.some((p) => access.permissions.includes(p))
              ? "allowed"
              : "denied",
          }),
        },
      },
      (name) =>
        new Proxy({}, { get: (_target, prop) => `${name}#${String(prop)}` }),
    );
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node.type === "string") types.push(node.type);
      walk(node.props?.children);
    };
    walk(options.component());
    return types;
  }
  const pushControl = (types) =>
    types.filter((type) =>
      /facility-staff\/components\/.*(push|notif)/i.test(type),
    );

  test("a receiver gets a push control next to the alarm layer", () => {
    assert.ok(
      pushControl(layoutTypes(["facility.emergency.respond"])).length > 0,
    );
  });

  test("someone without the respond permission gets none", () => {
    assert.deepEqual(pushControl(layoutTypes(["pos.sale.create"])), []);
  });
});

describe("legend-ofq4f 791 item 6 ops area door", () => {
  test("a role whose only ops permission is facility.emergency.respond may enter /fasilitas", async () => {
    const { AREAS } = await import("../apps/web/src/lib/areas/definitions.ts");
    assert.ok(AREAS.ops.basePaths.includes("/fasilitas"));
    assert.ok(AREAS.ops.guard.anyOf.includes("facility.emergency.respond"));
  });
});

describe("legend-ofq4f 791 item 7 PIN recovery returns to the origin facility", () => {
  const source = read(
    "apps/web/src/features/ws01-device-pin/components/switch-user-screen.tsx",
  );
  const branch = source.slice(
    source.indexOf("if (emergency) {"),
    source.indexOf("return;", source.indexOf("if (emergency) {")),
  );

  test("the emergency success navigation to /fasilitas carries search params", () => {
    assert.match(branch, /navigate\(/);
    assert.match(branch, /to:\s*"\/fasilitas"/);
    assert.match(branch, /\bsearch\b/);
    assert.doesNotMatch(branch, /navigate\(\{\s*to:\s*"\/fasilitas"\s*\}\)/);
  });

  test("the destination stays an internal fixed path", () => {
    assert.doesNotMatch(branch, /window\.location|location\.href|href:/);
  });

  test("the recovery route hands the origin facility to the screen", () => {
    const route = read("apps/web/src/routes/_ops/pos.ganti-pengguna.tsx");
    assert.match(route, /facilityId/);
  });
});
