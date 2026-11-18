// Emergency button never touches money (founder rule "jangan sampai rugi").
//
// 1. The route surface of the two emergency routers is pinned EXACTLY (read
//    from the Express router stack), so a new route there fails this test and
//    must be reviewed. No path may name money (refund, payment, voucher, cash,
//    void, credit, deposit).
// 2. A receiver session cookie (`legend_emergency`) is not an account session:
//    it must not authorize the reservation money routes (401).
//
// Assumption: the cookie test sends no Better Auth session at all, so
// `requireAuth` answers 401 before any outlet or body check.
import { randomUUID } from "node:crypto";
import type { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { emergencySessionRouter } from "../routes/emergency.routes.ts";
import { emergencyPressRouter } from "../routes/emergency-press.routes.ts";
import { originHeader } from "./helpers.ts";
import { PANIC_COOKIE_NAME } from "./panic-test-helpers.ts";

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
};

function routesOf(router: Router): string[] {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods)
        .filter((method) => layer.route!.methods[method])
        .map((method) => `${method.toUpperCase()} ${layer.route!.path}`),
    )
    .sort();
}

const MONEY_WORDS = /refund|payment|voucher|cash|void|credit|deposit/i;

describe("emergency routers expose no money route", () => {
  it("emergency session router has exactly POST / and DELETE /current", () => {
    expect(routesOf(emergencySessionRouter)).toEqual(
      ["DELETE /current", "POST /"].sort(),
    );
  });

  it("emergency press router has exactly the four press/alert routes", () => {
    expect(routesOf(emergencyPressRouter)).toEqual(
      [
        "POST /press",
        "POST /alerts/:alertId/ack",
        "GET /fallback",
        "GET /open-alerts",
      ].sort(),
    );
  });

  it("no emergency route path names money", () => {
    const all = [
      ...routesOf(emergencySessionRouter),
      ...routesOf(emergencyPressRouter),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const route of all) expect(route, route).not.toMatch(MONEY_WORDS);
  });
});

describe("emergency cookie does not open reservation money routes", () => {
  it("legend_emergency cookie on cancel / no-show / credit apply is 401", async () => {
    const app = createApp();
    const cookie = `${PANIC_COOKIE_NAME}=${randomUUID()}.${randomUUID()}`;
    const outlet = randomUUID();
    const reservation = randomUUID();
    const paths = [
      `/api/outlets/${outlet}/reservations/${reservation}/cancel`,
      `/api/outlets/${outlet}/reservations/${reservation}/no-show`,
      `/api/outlets/${outlet}/reservation-customer-credit/apply`,
    ];
    for (const path of paths) {
      const res = await request(app)
        .post(path)
        .set(originHeader)
        .set("Cookie", cookie)
        .set("Idempotency-Key", `emergency-${randomUUID()}`)
        .send({});
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(401);
    }
  });
});
