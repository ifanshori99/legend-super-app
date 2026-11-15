import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function worker() {
  const listeners = new Map();
  const notifications = [];
  const opened = [];
  const path = new URL("../apps/web/public/sw.js", import.meta.url);
  runInNewContext(existsSync(path) ? readFileSync(path, "utf8") : "", {
    URL,
    self: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      registration: {
        showNotification: async (...args) => notifications.push(args),
      },
      clients: {
        matchAll: async () => [],
        openWindow: async (url) => opened.push(url),
      },
      location: { origin: "https://legend.example.test" },
    },
  });
  const dispatch = async (name, event) => {
    assert.equal(
      typeof listeners.get(name),
      "function",
      `service worker handles ${name}`,
    );
    let pending;
    listeners.get(name)({
      ...event,
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
  };
  return { dispatch, notifications, opened };
}

test("legend-po3fe push service worker displays the alarm with its stable alert tag", async () => {
  const harness = worker();
  await harness.dispatch("push", {
    data: {
      json: () => ({
        title: "Darurat P1",
        body: "Area Pria",
        tag: "alert-reference-1",
        data: { url: "/fasilitas" },
      }),
    },
  });
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0][0], "Darurat P1");
  assert.equal(harness.notifications[0][1].body, "Area Pria");
  assert.equal(harness.notifications[0][1].tag, "alert-reference-1");
});

test("legend-po3fe notification clicks never open a supplied external URL", async () => {
  const harness = worker();
  let closed = false;
  await harness.dispatch("notificationclick", {
    notification: {
      data: { url: "https://evil.example.test" },
      close: () => {
        closed = true;
      },
    },
  });
  assert.equal(closed, true);
  assert.equal(harness.opened.length, 1);
  assert.match(
    harness.opened[0],
    /^(?:https:\/\/legend\.example\.test)?\/(?:fasilitas)?$/,
  );
});

test("legend-po3fe notification clicks retain a safe internal destination for other notifications", async () => {
  const harness = worker();
  const link = "/pos/pesanan?tab=siap";
  await harness.dispatch("notificationclick", {
    notification: { data: { url: link }, close() {} },
  });
  assert.equal(harness.opened.length, 1);
  assert.equal(
    harness.opened[0].replace("https://legend.example.test", ""),
    link,
  );
});
