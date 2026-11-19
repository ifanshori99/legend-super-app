// DOIT recurring billing kill switch (legend-1102): the adapter calls
// /v1/recurring/*, the DOIT docs publish /v1/billing/*. With
// DOIT_RECURRING_ENABLED off (the default) every /api/payments/recurring
// request answers 503 before auth, any DOIT call or any database write,
// except pause and cancel: a stop only limits payment (brief 1164 ronde 2,
// Kartu D), so those two reach auth and the service.
import type { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../app";
import { env } from "../config/env";
import { originHeader } from "./helpers";
import {
  createOwnerPool,
  requireDisposableDatabase,
} from "./tenant-isolation-harness";

const app = createApp();
const base = "/api/payments/recurring";
const TABLES = [
  "payment_recurring_plans",
  "payment_recurring_subscriptions",
  "subscription_invoices",
  "payment_recurring_outlet_settings",
];
let owner: Pool;
let wasEnabled: boolean;

async function rowCounts(): Promise<number[]> {
  const counts: number[] = [];
  for (const table of TABLES) {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    counts.push(Number(rows[0]!.n));
  }
  return counts;
}

beforeAll(() => {
  requireDisposableDatabase();
  owner = createOwnerPool();
  wasEnabled = env.DOIT_RECURRING_ENABLED;
});

afterEach(() => {
  env.DOIT_RECURRING_ENABLED = wasEnabled;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await owner.end();
});

describe("DOIT_RECURRING_ENABLED", () => {
  it("is off by default", () => {
    expect(wasEnabled).toBe(false);
  });

  it("off: every method answers 503, no DOIT call, no new rows", async () => {
    env.DOIT_RECURRING_ENABLED = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await rowCounts();

    const calls = [
      request(app).get(`${base}/plans`).set(originHeader),
      request(app)
        .post(`${base}/plans`)
        .set(originHeader)
        .send({ name: "Paket", amountIdr: 100000 }),
      request(app)
        .post(
          `${base}/subscriptions/00000000-0000-4000-8000-000000000000/resume`,
        )
        .set(originHeader)
        .send({}),
    ];
    for (const call of calls) {
      const response = await call;
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("RECURRING_BILLING_DISABLED");
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCounts()).toEqual(before);
  });

  it("off: pause and cancel are not switched off (auth runs, answers 401)", async () => {
    env.DOIT_RECURRING_ENABLED = false;
    for (const action of ["pause", "cancel"]) {
      const response = await request(app)
        .post(
          `${base}/subscriptions/00000000-0000-4000-8000-000000000000/${action}`,
        )
        .set(originHeader)
        .send({});
      expect(response.status).toBe(401);
    }
  });

  it("on: the route is reachable (auth runs, answers 401)", async () => {
    env.DOIT_RECURRING_ENABLED = true;
    const response = await request(app).get(`${base}/plans`).set(originHeader);
    expect(response.status).toBe(401);
  });
});
