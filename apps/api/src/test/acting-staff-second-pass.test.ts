// resolveActingStaff second pass (wave 2, legend-ptn11). Several POS routers
// share one URL prefix, so the middleware can run twice on one request. The
// token is resolved on the first pass only (req.actingStaff is set). A later
// pass must not trust a stale outlet: when req.params.outletId differs from the
// outlet the token was issued for, the request is refused with
// 403 ACTING_STAFF_OUTLET_MISMATCH. Same outlet (any letter case) or no
// :outletId param => next() with no error.
//
// Pure unit test: the exported middleware is called directly with a hand-built
// req, so no DB or app boot is needed. On the second pass no service is hit.
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { resolveActingStaff } from "../middleware/acting-staff.ts";

const OUTLET_A = "0192f6a0-0000-7000-8000-00000000000a";
const OUTLET_B = "0192f6a0-0000-7000-8000-00000000000b";

function makeReq(opts: {
  header?: boolean;
  params?: Record<string, unknown>;
  tokenOutletId?: string;
}): Request {
  return {
    headers: opts.header === false ? {} : { "x-acting-staff": "x" },
    params: opts.params ?? {},
    actingStaff: {
      staffUserId: "staff-1",
      sessionUserId: "owner-1",
      tokenId: "token-1",
      outletId: opts.tokenOutletId ?? OUTLET_A,
    },
  } as unknown as Request;
}

// The middleware is async; wrap so a sync throw or a rejection both surface as
// a rejected promise.
async function run(req: Request, next: ReturnType<typeof vi.fn>) {
  await resolveActingStaff(
    req,
    {} as Response,
    next as unknown as NextFunction,
  );
}

describe("resolveActingStaff second pass", () => {
  it("rejects 403 ACTING_STAFF_OUTLET_MISMATCH when :outletId differs from the token outlet", async () => {
    const next = vi.fn();
    const req = makeReq({ params: { outletId: OUTLET_B } });
    await expect(run(req, next)).rejects.toMatchObject({
      status: 403,
      code: ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when :outletId equals the token outlet", async () => {
    const next = vi.fn();
    await run(makeReq({ params: { outletId: OUTLET_A } }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("compares the outlet case-insensitively", async () => {
    const next = vi.fn();
    const req = makeReq({
      params: { outletId: OUTLET_A.toUpperCase() },
      tokenOutletId: OUTLET_A.toLowerCase(),
    });
    await run(req, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() when the route has no :outletId param", async () => {
    const next = vi.fn();
    await run(makeReq({ params: {} }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() when the request has no X-Acting-Staff header", async () => {
    const next = vi.fn();
    // Even with a differing outlet: without the header the middleware is a no-op.
    await run(makeReq({ header: false, params: { outletId: OUTLET_B } }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
