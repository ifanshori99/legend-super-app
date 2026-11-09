// legend-1rmk: a peak window ending 24:00 shows as 00:00 in the time input
// (type=time cannot hold 24:00) and maps back to 24:00 in the request body.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  peakEndToBody,
  peakEndToInput,
} from "../apps/web/src/features/facility-admin/peak-window.ts";

describe("peak window end form mapping (legend-1rmk)", () => {
  test("24:00 shows as 00:00 in the input", () => {
    assert.equal(peakEndToInput("24:00"), "00:00");
  });

  test("00:00 in the input maps back to 24:00 in the body", () => {
    assert.equal(peakEndToBody("00:00"), "24:00");
  });

  test("other times pass through unchanged", () => {
    for (const time of ["", "00:01", "14:00", "23:59"]) {
      assert.equal(peakEndToInput(time), time);
      assert.equal(peakEndToBody(time), time);
    }
  });

  test("a stored 24:00 round-trips", () => {
    assert.equal(peakEndToBody(peakEndToInput("24:00")), "24:00");
  });
});
