// Support access UX rules (bead legend-335). Cites PRD v1.7 §3 F4 "Support
// Access" (60-minute default, read-only, ended early or expired) and TEN-04.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as logic from "../apps/web/src/features/ws01-support-access/logic.ts";

const grant = {
  startedAt: "2026-11-01T04:30:00.000Z",
  expiresAt: "2026-11-01T05:30:00.000Z",
  endedAt: null,
};
const at = (iso) => Date.parse(iso);

test("TEN-04: countdown formats mm:ss under an hour and h:mm:ss above", () => {
  assert.equal(logic.formatCountdown(59 * 60_000 + 7_000), "59:07");
  assert.equal(logic.formatCountdown(60 * 60_000), "1:00:00");
  assert.equal(logic.formatCountdown(-5_000), "00:00");
});

test("TEN-04: a session is active only between start and expiry, and not once ended", () => {
  assert.equal(
    logic.isGrantActive(grant, at("2026-11-01T05:00:00.000Z")),
    true,
  );
  assert.equal(
    logic.isGrantActive(grant, at("2026-11-01T05:30:00.000Z")),
    false,
  );
  assert.equal(
    logic.isGrantActive(grant, at("2026-11-01T04:00:00.000Z")),
    false,
  );
  const ended = { ...grant, endedAt: "2026-11-01T04:45:00.000Z" };
  assert.equal(
    logic.isGrantActive(ended, at("2026-11-01T05:00:00.000Z")),
    false,
  );
});

test("TEN-04: the banner turns urgent in the last five minutes", () => {
  assert.equal(
    logic.isExpiringSoon(grant.expiresAt, at("2026-11-01T05:24:00.000Z")),
    false,
  );
  assert.equal(
    logic.isExpiringSoon(grant.expiresAt, at("2026-11-01T05:26:00.000Z")),
    true,
  );
});

test("TEN-04: newest session first and the active one is found", () => {
  const older = {
    ...grant,
    startedAt: "2026-10-01T04:00:00.000Z",
    expiresAt: "2026-10-01T05:00:00.000Z",
  };
  const sorted = logic.sortGrantsNewestFirst([older, grant]);
  assert.equal(sorted[0], grant);
  assert.equal(
    logic.findActiveGrant([older, grant], at("2026-11-01T05:00:00.000Z")),
    grant,
  );
  assert.equal(
    logic.findActiveGrant([older], at("2026-11-01T05:00:00.000Z")),
    null,
  );
});

test("F4: the authenticator field keeps six digits only", () => {
  assert.equal(logic.sanitizeMfaCode("12a3-45 678"), "123456");
});
