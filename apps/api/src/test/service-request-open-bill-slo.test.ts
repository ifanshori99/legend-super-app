// Open-bill bill-request SLO (legend-2zb5; PRD v1.7 §3 F43 "Kontrol Open Bill",
// F10 "Minta Tagihan"; ORD-07 overdue escalation).
//
// The overdue sweep must judge a `request_bill` against the outlet policy's
// `billRequestSloSeconds` (default 180 s when the outlet has no policy row),
// while every other request type keeps the fixed 180 s threshold, and one
// outlet's policy never changes another outlet's verdict.
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Time is injected into the sweep, so nothing sleeps.
//
// Timing margins: a request is created at real time T0 and the sweep is called
// with `base + offset`, where `base` is taken BEFORE the requests exist. The
// elapsed time the sweep sees is therefore `offset - delta` with delta >= 0 a
// few milliseconds. Every offset sits at least 10 s away from the threshold it
// is checked against, so the verdicts never depend on scheduler jitter.
//
// Assumption: an outlet-scoped outlet_manager creates zones, tables and QR
// codes in that outlet (floor-api.test.ts and service-request-api.test.ts show
// the same for the seeded outlets), which gives one tenant two outlets.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { idr, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { upsertOpenBillPolicy } from "../services/open-bill-control.service";
import { sweepOverdueServiceRequests } from "../services/service-request.service";
import { agent, originHeader } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

let app: Express;
let managerA: Staff;
let managerB: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const requestIds: string[] = [];

type Guest = { sessionId: string; sessionToken: string };

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A zone, a table and a scanned guest session in the manager's outlet. */
async function newGuest(manager: Staff): Promise<Guest> {
  const zone = await createZone(manager.client);
  zoneIds.push(zone.id);
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(manager.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return {
    sessionId: scanned.body.data.session.id,
    sessionToken: scanned.body.data.sessionToken,
  };
}

/** The guest asks for the bill or calls the waiter; returns the request id. */
async function ask(
  guest: Guest,
  type: "request_bill" | "call_waiter",
): Promise<string> {
  const response = await agent(app)
    .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
    .set("Host", seededHostname)
    .set("Authorization", `Bearer ${guest.sessionToken}`)
    .send({
      type,
      ...(type === "call_waiter" ? { reason: "utensils" } : {}),
      idempotencyKey: randomUUID(),
    });
  expect(response.status).toBe(201);
  const id = response.body.data.id as string;
  requestIds.push(id);
  return id;
}

async function setSlo(outletId: string, seconds: number, actor: Staff) {
  await upsertOpenBillPolicy(
    tenantContext(),
    outletId,
    {
      maxBillValueIdr: idr(5_000_000),
      inactivityMinutes: 45,
      billRequestSloSeconds: seconds,
    },
    actor.userId,
  );
}

async function clearPolicies() {
  await owner.query(
    "DELETE FROM outlet_open_bill_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
    [seededTenantId, [seededOutletA, seededOutletB]],
  );
}

/** Sweeps as if `seconds` had passed since `base`. */
const sweepAt = (base: Date, seconds: number) =>
  sweepOverdueServiceRequests(
    new Date(base.getTime() + seconds * 1000),
    tenantContext(),
  );

async function overdueEvents(requestId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'service_request.overdue'`,
    [seededTenantId, requestId],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  app = createApp();
  managerA = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "SLO Manager A",
  });
  managerB = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletB,
    label: "SLO Manager B",
  });
});

// Each case states its own policy rows, so the order of cases never matters.
beforeEach(clearPolicies);

afterAll(async () => {
  await clearPolicies();
  await owner.query(
    "DELETE FROM service_requests WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [seededTenantId, requestIds],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("bill-request SLO from the outlet policy (legend-2zb5)", () => {
  it("ORD-07 a request_bill is overdue after the outlet's 60 s SLO, once", async () => {
    await setSlo(seededOutletA, 60, managerA);
    const base = new Date();
    const bill = await ask(await newGuest(managerA), "request_bill");

    expect(await sweepAt(base, 50)).not.toContain(bill);
    expect(await overdueEvents(bill)).toBe(0);

    expect(await sweepAt(base, 70)).toContain(bill);
    expect(await overdueEvents(bill)).toBe(1);
    // At most once per request, however often the sweep runs.
    expect(await sweepAt(base, 90)).not.toContain(bill);
    expect(await overdueEvents(bill)).toBe(1);
  });

  it("ORD-07 a call_waiter keeps the fixed 180 s threshold under a 60 s bill SLO", async () => {
    await setSlo(seededOutletA, 60, managerA);
    const base = new Date();
    const bill = await ask(await newGuest(managerA), "request_bill");
    const waiter = await ask(await newGuest(managerA), "call_waiter");

    const afterSlo = await sweepAt(base, 70);
    expect(afterSlo).toContain(bill);
    expect(afterSlo).not.toContain(waiter);
    expect(await sweepAt(base, 170)).not.toContain(waiter);
    expect(await overdueEvents(waiter)).toBe(0);

    expect(await sweepAt(base, 190)).toContain(waiter);
    expect(await overdueEvents(waiter)).toBe(1);
  });

  it("ORD-07 an outlet without a policy judges a request_bill at the default 180 s", async () => {
    // The default is 180 s: not "never overdue" and not shorter.
    const base = new Date();
    const bill = await ask(await newGuest(managerA), "request_bill");

    expect(await sweepAt(base, 170)).not.toContain(bill);
    expect(await overdueEvents(bill)).toBe(0);
    expect(await sweepAt(base, 190)).toContain(bill);
    expect(await overdueEvents(bill)).toBe(1);
  });

  it("ORD-07 a longer SLO than the default delays the escalation", async () => {
    await setSlo(seededOutletA, 300, managerA);
    const base = new Date();
    const bill = await ask(await newGuest(managerA), "request_bill");

    // Past the default 180 s, still inside the outlet's 300 s.
    expect(await sweepAt(base, 190)).not.toContain(bill);
    expect(await sweepAt(base, 290)).not.toContain(bill);
    expect(await sweepAt(base, 310)).toContain(bill);
    expect(await overdueEvents(bill)).toBe(1);
  });

  it("ORD-07 one outlet's SLO never changes another outlet's verdict", async () => {
    // Outlet A: short SLO. Outlet B: a longer one. A third request on B's
    // sibling without a row is covered by the default case above.
    await setSlo(seededOutletA, 60, managerA);
    await setSlo(seededOutletB, 300, managerB);
    const base = new Date();
    const billA = await ask(await newGuest(managerA), "request_bill");
    const billB = await ask(await newGuest(managerB), "request_bill");

    const early = await sweepAt(base, 70);
    expect(early).toContain(billA);
    expect(early).not.toContain(billB);

    // A's 60 s must not leak to B, and B's 300 s must not leak to A.
    expect(await sweepAt(base, 190)).not.toContain(billB);
    expect(await sweepAt(base, 310)).toContain(billB);
    expect(await overdueEvents(billA)).toBe(1);
    expect(await overdueEvents(billB)).toBe(1);
  });

  it("ORD-07 an outlet with a policy does not shorten an outlet without one", async () => {
    await setSlo(seededOutletA, 60, managerA);
    const base = new Date();
    const billB = await ask(await newGuest(managerB), "request_bill");

    // Outlet B has no row: 70 s is well inside its default 180 s.
    expect(await sweepAt(base, 70)).not.toContain(billB);
    expect(await sweepAt(base, 170)).not.toContain(billB);
    expect(await sweepAt(base, 190)).toContain(billB);
  });

  it("ORD-07 a resolved request_bill is never escalated, whatever the SLO", async () => {
    await setSlo(seededOutletA, 60, managerA);
    const base = new Date();
    const bill = await ask(await newGuest(managerA), "request_bill");
    const acknowledged = await managerA.client
      .post(`/api/service-requests/${bill}/acknowledge`)
      .set("Host", seededHostname)
      .set(originHeader);
    expect(acknowledged.status).toBe(200);
    const resolved = await managerA.client
      .post(`/api/service-requests/${bill}/resolve`)
      .set("Host", seededHostname)
      .set(originHeader)
      .send({});
    expect(resolved.status).toBe(200);

    expect(await sweepAt(base, 400)).not.toContain(bill);
    expect(await overdueEvents(bill)).toBe(0);
  });
});
