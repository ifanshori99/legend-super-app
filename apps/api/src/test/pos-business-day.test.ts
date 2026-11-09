// Business-day boundary (founder Q9, 2026-11-08): the business day is closed
// by the outlet manager and the day changes at 04:00, so 00:00-03:59 belongs
// to the previous day. Orders and shifts are stamped with `businessDateFor`.
//
// Assumption: the clock is the outlet's own time zone (default Asia/Jakarta,
// UTC+7); instants below are written with the +07:00 offset.

import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_DAY_CUTOFF } from "@starter/shared/core";
import { outlets } from "../db/schema/index.ts";
import { businessDateFor } from "../services/pos-order-support.ts";

const outlet = {
  timezone: "Asia/Jakarta",
  businessDayCutoff: "04:00",
} as never;

describe("Q9 business day cutoff 04:00", () => {
  it("00:00-03:59 belongs to the previous business day, 04:00 starts the new one", () => {
    expect(businessDateFor(outlet, new Date("2026-11-05T03:59:00+07:00"))).toBe(
      "2026-11-04",
    );
    expect(businessDateFor(outlet, new Date("2026-11-05T04:00:00+07:00"))).toBe(
      "2026-11-05",
    );
    expect(businessDateFor(outlet, new Date("2026-11-05T00:00:00+07:00"))).toBe(
      "2026-11-04",
    );
  });

  it("the end of the evening and the next morning stay on the same day until 04:00", () => {
    expect(businessDateFor(outlet, new Date("2026-11-04T23:59:00+07:00"))).toBe(
      "2026-11-04",
    );
    expect(businessDateFor(outlet, new Date("2026-11-05T12:00:00+07:00"))).toBe(
      "2026-11-05",
    );
  });

  it("a new outlet defaults to cutoff 04:00 in the database column and the shared constant", () => {
    expect(DEFAULT_BUSINESS_DAY_CUTOFF).toBe("04:00");
    expect(outlets.businessDayCutoff.default).toBe("04:00");
  });
});
