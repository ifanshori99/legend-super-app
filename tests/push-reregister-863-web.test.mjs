// legend-xdlxa / 863: the push status shown in the UI must come from the
// server, and a browser that holds a push subscription the server no longer
// counts is registered again automatically. Written from the design contract
// (push-sync.ts: isRegisteredOnServer / syncPushRegistration), not from the
// engineer's code.
//
// ASSUMPTIONS where the design is silent:
//  - "Never throws out" also covers a listDevices that throws synchronously
//    (not only a rejected promise) and a register that throws synchronously.
//  - The device list is only compared by `id`; extra fields are ignored.
//  - A non-"active" browser state means skipped, for EVERY other PushState
//    value (including the two new ones); no dependency is touched.
//  - The catalog check only covers the four new notification.push.* keys:
//    present, non-empty Indonesian text, and the two new state labels differ
//    from the existing "Aktif di perangkat ini".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";

const { isRegisteredOnServer, syncPushRegistration } =
  await import("../apps/web/src/features/ws05-notifications/push-sync.ts");

/** Dependencies that record every call and never settle on their own. */
function harness({
  browserState = "active",
  storedId = "sub-1",
  devices = [{ id: "sub-1" }],
  listError,
  registerError,
} = {}) {
  const calls = { list: 0, register: 0 };
  const deps = {
    browserState,
    storedId,
    listDevices: async () => {
      calls.list += 1;
      if (listError) throw listError;
      return devices;
    },
    register: async () => {
      calls.register += 1;
      if (registerError) throw registerError;
    },
  };
  return { deps, calls };
}

describe("isRegisteredOnServer (863)", () => {
  test("true only when the stored id is in the server list", () => {
    assert.equal(isRegisteredOnServer([{ id: "a" }, { id: "b" }], "b"), true);
    assert.equal(isRegisteredOnServer([{ id: "a" }], "b"), false);
  });

  test("an empty server list never matches", () => {
    assert.equal(isRegisteredOnServer([], "a"), false);
  });

  test("a null stored id is never registered, even next to other rows", () => {
    assert.equal(isRegisteredOnServer([{ id: "a" }], null), false);
    assert.equal(isRegisteredOnServer([], null), false);
  });

  test("extra fields on the device rows are ignored", () => {
    assert.equal(
      isRegisteredOnServer(
        [{ id: "a", current: true, deviceLabel: "HP", sessionActive: true }],
        "a",
      ),
      true,
    );
  });
});

describe("syncPushRegistration (863)", () => {
  test("browser not active: skipped and nothing is called", async () => {
    for (const browserState of [
      "inactive",
      "blocked",
      "unsupported",
      "unavailable",
      "ios-install",
      "checking",
      "reregistering",
      "needs-reregister",
    ]) {
      const { deps, calls } = harness({ browserState });
      assert.equal(await syncPushRegistration(deps), "skipped", browserState);
      assert.deepEqual(calls, { list: 0, register: 0 }, browserState);
    }
  });

  test("server already lists the stored id: confirmed, no register", async () => {
    const { deps, calls } = harness({
      storedId: "sub-2",
      devices: [{ id: "sub-1" }, { id: "sub-2" }],
    });
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(calls.list, 1);
    assert.equal(calls.register, 0);
  });

  test("server does not list the stored id: registers again", async () => {
    const { deps, calls } = harness({
      storedId: "old",
      devices: [{ id: "other" }],
    });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("server list empty (legacy row hidden): registers again", async () => {
    const { deps, calls } = harness({ devices: [] });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("browser has a subscription but no stored id: registers again", async () => {
    const { deps, calls } = harness({
      storedId: null,
      devices: [{ id: "sub-1" }],
    });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.register, 1);
  });

  test("listing the devices fails: registers again instead of trusting the browser", async () => {
    const { deps, calls } = harness({ listError: new Error("offline") });
    assert.equal(await syncPushRegistration(deps), "reregistered");
    assert.equal(calls.list, 1);
    assert.equal(calls.register, 1);
  });

  test("register fails after a missing id: failed, does not throw", async () => {
    const { deps, calls } = harness({
      devices: [],
      registerError: new Error("500"),
    });
    assert.equal(await syncPushRegistration(deps), "failed");
    assert.equal(calls.register, 1);
  });

  test("both listing and register fail: failed, does not throw", async () => {
    const { deps, calls } = harness({
      listError: new Error("offline"),
      registerError: new Error("offline"),
    });
    assert.equal(await syncPushRegistration(deps), "failed");
    assert.equal(calls.register, 1);
  });

  test("synchronous throws from the dependencies are swallowed too", async () => {
    const throwingList = {
      browserState: "active",
      storedId: "sub-1",
      listDevices: () => {
        throw new Error("sync list");
      },
      register: async () => {},
    };
    assert.equal(await syncPushRegistration(throwingList), "reregistered");

    const throwingRegister = {
      browserState: "active",
      storedId: null,
      listDevices: async () => [],
      register: () => {
        throw new Error("sync register");
      },
    };
    assert.equal(await syncPushRegistration(throwingRegister), "failed");
  });

  test("a confirmed run never registers even when called repeatedly", async () => {
    const { deps, calls } = harness();
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(await syncPushRegistration(deps), "confirmed");
    assert.equal(calls.register, 0);
  });
});

describe("push re-register texts (863)", () => {
  const t = createTranslator();
  const NEW_KEYS = [
    "stateReregistering",
    "stateNeedsReregister",
    "reregisterAction",
    "reregisterHint",
  ];

  test("every new key is a catalog key with non-empty text", () => {
    for (const name of NEW_KEYS) {
      const key = `notification.push.${name}`;
      assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
      const text = t(key);
      assert.ok(
        typeof text === "string" && text.trim().length > 0,
        `${key} is empty`,
      );
      assert.notEqual(text, key, `${key} resolves to its own key`);
    }
  });

  test("the new state labels are distinct from the active label", () => {
    const active = t("notification.push.stateActive");
    assert.notEqual(t("notification.push.stateReregistering"), active);
    assert.notEqual(t("notification.push.stateNeedsReregister"), active);
    assert.notEqual(
      t("notification.push.stateReregistering"),
      t("notification.push.stateNeedsReregister"),
    );
  });
});
