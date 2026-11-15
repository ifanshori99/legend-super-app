// Alarm devices card text contract (bead legend-gchkf): every staffAuth.pushDevices.*
// key resolves to plain Indonesian through the real translator, with its
// placeholders filled, and avoids the technical term the owner never sees.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";

const t = createTranslator();
const PREFIX = "staffAuth.pushDevices.";
const KEYS = [
  "title",
  "description",
  "unnamed",
  "registeredAt",
  "statusSessionActive",
  "statusSessionEnded",
  "currentBadge",
  "revoke",
  "revokeLabel",
  "revokeTitle",
  "revokeDescription",
  "revokeCurrentWarning",
  "revokeSessionNote",
  "revokeConfirm",
  "revoked",
  "revokeFailed",
  "revokeGone",
  "loadErrorTitle",
  "loadErrorHint",
  "emptyTitle",
  "emptyHint",
];

describe("alarm devices card text (legend-gchkf)", () => {
  test("every key is a catalog key and resolves to non-empty text", () => {
    for (const name of KEYS) {
      const key = PREFIX + name;
      assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
      const value = t(key);
      assert.notEqual(value, key, `${key} does not resolve`);
      assert.ok(value.trim().length > 0, `${key} is empty`);
    }
  });

  test("no extra pushDevices keys are left untested", () => {
    const actual = MESSAGE_KEYS.filter((key) => key.startsWith(PREFIX)).sort();
    assert.deepEqual(actual, KEYS.map((name) => PREFIX + name).sort());
  });

  test("an unnamed phone and an ended session have the agreed wording", () => {
    assert.equal(t(PREFIX + "unnamed"), "Perangkat tanpa nama");
    assert.equal(
      t(PREFIX + "statusSessionEnded"),
      "Sudah keluar, masih menerima alarm",
    );
  });

  test("current device and session notes have the agreed wording", () => {
    assert.equal(t(PREFIX + "currentBadge"), "Perangkat ini");
    assert.ok(
      t(PREFIX + "revokeCurrentWarning").startsWith(
        "Ini perangkat yang sedang kamu pakai.",
      ),
    );
    assert.ok(t(PREFIX + "revokeSessionNote").includes("ikut keluar"));
  });

  test("wording says perangkat, never HP", () => {
    for (const name of KEYS) {
      assert.ok(
        !/\bHP\b/.test(t(PREFIX + name, { device: "x", time: "x" })),
        name,
      );
    }
  });

  test("placeholders are filled with the device name", () => {
    for (const name of ["revokeLabel", "revokeDescription", "revoked"]) {
      const text = t(PREFIX + name, { device: "HP Kasir" });
      assert.ok(text.includes("HP Kasir"), `${name} lost {device}`);
      assert.ok(!text.includes("{"), `${name} has an unfilled placeholder`);
    }
    const when = t(PREFIX + "registeredAt", { time: "12 Nov 10.00" });
    assert.ok(when.includes("12 Nov 10.00") && !when.includes("{"));
  });

  test("no technical wording reaches the owner", () => {
    for (const name of KEYS) {
      const text = t(PREFIX + name, { device: "HP", time: "x" });
      assert.ok(!/push|subscription|endpoint|token/i.test(text), name);
    }
  });
});
