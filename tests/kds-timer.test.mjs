// KDS ticket timer colors (bead legend-10n): near at 80% of the station
// target, late at the target (PRD "KDS per Stasiun", coordinator decision).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KDS_NEAR_TARGET_BP,
  formatElapsedSeconds,
  kdsTimerStatus,
} from "../apps/web/src/features/ws04-kds/timer.ts";

test("legend-10n: KDS timer is on track, near at 80% and late at the target", () => {
  assert.equal(KDS_NEAR_TARGET_BP, 8_000);
  const target = 600; // 10 minutes
  assert.equal(kdsTimerStatus(0, target), "onTrack");
  assert.equal(kdsTimerStatus(479, target), "onTrack");
  assert.equal(kdsTimerStatus(480, target), "near");
  assert.equal(kdsTimerStatus(599, target), "near");
  assert.equal(kdsTimerStatus(600, target), "late");
  assert.equal(kdsTimerStatus(1_200, target), "late");
});

test("legend-10n: the 80% boundary has no float error on odd targets", () => {
  // 7 min target: 80% = 336 s exactly.
  assert.equal(kdsTimerStatus(335, 420), "onTrack");
  assert.equal(kdsTimerStatus(336, 420), "near");
  // 1 s target: 0.8 s rounds to no "near" window before late.
  assert.equal(kdsTimerStatus(0, 1), "onTrack");
  assert.equal(kdsTimerStatus(1, 1), "late");
});

// legend-ujxl (owner Q26): the ticket band shows the elapsed time as
// minutes:seconds so a kitchen reads a real timer, not a rounded minute count.
test("legend-ujxl: the ticket band formats elapsed time as minutes:seconds", () => {
  assert.equal(formatElapsedSeconds(0), "0:00");
  assert.equal(formatElapsedSeconds(59), "0:59");
  assert.equal(formatElapsedSeconds(60), "1:00");
  assert.equal(formatElapsedSeconds(1_084), "18:04");
  assert.equal(formatElapsedSeconds(7_205), "120:05");
  // A clock skew or a fixture in the future never shows a negative timer.
  assert.equal(formatElapsedSeconds(-5), "0:00");
  assert.equal(formatElapsedSeconds(59.9), "0:59");
});
