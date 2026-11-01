// Pickup display announcements (bead legend-zvz): which numbers the wall
// display reads out, and what it does on a device without speech. The screen
// must never announce the whole day's list when it opens, and must never speak
// a number twice for one call.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  announcePickupNumber,
  newlyCalledCalls,
  pickupSpeechSupported,
  readPickupSoundEnabled,
  writePickupSoundEnabled,
} from "../apps/web/src/features/ws04-expo/sound.ts";

const call = (number, status, calledAt = null) => ({
  id: `call-${number}`,
  number,
  status,
  calledAt,
  pickedUpAt: null,
});

test("PRD §3 F12 pickup display: the first snapshot announces nothing", () => {
  const snapshot = [
    call(12, "called", "2026-11-01T04:12:00.000Z"),
    call(13, "assigned"),
  ];
  assert.deepEqual(newlyCalledCalls(null, snapshot), []);
});

test("PRD §3 F12 pickup display: only numbers called since the last read", () => {
  const before = [
    call(12, "called", "2026-11-01T04:12:00.000Z"),
    call(13, "assigned"),
  ];
  const after = [
    call(12, "picked_up", "2026-11-01T04:12:00.000Z"),
    call(13, "called", "2026-11-01T04:20:00.000Z"),
    call(14, "assigned"),
  ];
  assert.deepEqual(
    newlyCalledCalls(before, after).map((row) => row.number),
    [13],
    "a pick-up is not a new call; 13 is",
  );
});

test("PRD §3 F12 pickup display: numbers are announced in call order", () => {
  const before = [call(12, "assigned"), call(15, "assigned")];
  const after = [
    call(15, "called", "2026-11-01T04:22:00.000Z"),
    call(12, "called", "2026-11-01T04:21:00.000Z"),
  ];
  assert.deepEqual(
    newlyCalledCalls(before, after).map((row) => row.number),
    [12, 15],
  );
});

test("PRD §3 F12 pickup display: no speech without a browser voice", () => {
  // Node has no window, so the display must degrade to the screen alone.
  assert.equal(pickupSpeechSupported(), false);
  assert.equal(announcePickupNumber("Nomor 12"), false);
});

test("PRD §3 F12 pickup display: the sound choice is off until the device sets it", () => {
  assert.equal(readPickupSoundEnabled(), false);
  // Writing outside a browser must not throw on the server render.
  writePickupSoundEnabled(true);
  assert.equal(readPickupSoundEnabled(), false);
});

test("PRD §3 F12 pickup display: call order wins over number order", () => {
  const before = [call(12, "assigned"), call(15, "assigned")];
  const after = [
    call(12, "called", "2026-11-01T04:23:00.000Z"),
    call(15, "called", "2026-11-01T04:22:00.000Z"),
  ];
  assert.deepEqual(
    newlyCalledCalls(before, after).map((row) => row.number),
    [15, 12],
  );
});
