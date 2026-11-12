import { describe, expect, it } from "vitest";
import {
  decideLeaveRequest,
  decideOvertimeRequest,
  decideShiftSwapRequest,
} from "@starter/shared/hris";

const key = "hris-rejection-reason-test-123";

describe("legend-ss1xn rejection reasons", () => {
  it.each([
    ["leave", decideLeaveRequest.body, {}],
    ["overtime", decideOvertimeRequest.body, {}],
    ["swap", decideShiftSwapRequest.body, { overrideReason: null }],
  ] as const)(
    "requires a nonblank reason when rejecting %s",
    (_name, schema, extra) => {
      const input = { action: "reject", idempotencyKey: key, ...extra };
      expect(schema.safeParse(input).success).toBe(false);
      expect(
        schema.safeParse({ ...input, rejectionReason: "   " }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...input, rejectionReason: "Jadwal penuh" }).success,
      ).toBe(true);
    },
  );
});
