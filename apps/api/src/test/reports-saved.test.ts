// Fail-first tests for saved builder reports (WS-11 F12, bead legend-ay6e6).
// Written from the contract in packages/shared/src/dashboard/endpoints.ts and
// builder.ts (savedReportSchema: "a saved report is private to its owner and
// only visible to roles that already hold the builder permissions").
// Everything goes over HTTP, so auth, permission and tenant isolation are part
// of what is pinned.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  savedReportPageSchema,
  savedReportSchema,
} from "@starter/shared/dashboard";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";
import { owner } from "./floor-test-helpers";
import {
  JUNE,
  makeDeliveryWorld,
  worldUsers,
  type DeliveryWorld,
  type Member,
} from "./report-delivery-helpers";

let app: Express;
let a: DeliveryWorld;
let b: DeliveryWorld;

const PATH = "/api/reports/saved";
const QUERY = { metricCodes: ["net_sales"], period: JUNE };

const create = (m: Member | null, body: unknown, host = m?.host ?? a.host) =>
  (m?.client ?? agent(app))
    .post(PATH)
    .set(originHeader)
    .set("Host", host)
    .send(body as object);
const patch = (m: Member, id: string, body: unknown, host = m.host) =>
  m.client
    .patch(`${PATH}/${encodeURIComponent(id)}`)
    .set(originHeader)
    .set("Host", host)
    .send(body as object);
const list = (m: Member, query = "", host = m.host) =>
  m.client.get(`${PATH}${query}`).set("Host", host);

async function saved(m: Member, name = `Laporan ${randomUUID().slice(0, 6)}`) {
  const response = await create(m, { name, query: QUERY });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return savedReportSchema.parse(response.body.data);
}

beforeAll(async () => {
  app = createApp();
  a = await makeDeliveryWorld(app, "sa");
  b = await makeDeliveryWorld(app, "sb");
});

afterAll(async () => {
  const users = [...worldUsers(a), ...worldUsers(b)];
  await owner.query("DELETE FROM saved_reports WHERE owner_user_id = ANY($1)", [
    users,
  ]);
  await owner.end();
});

describe("POST /api/reports/saved", () => {
  it("answers 401 without a session", async () => {
    expect((await create(null, { name: "x", query: QUERY })).status).toBe(401);
  });

  it("saves the builder query for the caller, in the caller's tenant", async () => {
    const report = await saved(a.full, "Penjualan Juni");
    expect(report.name).toBe("Penjualan Juni");
    expect(report.ownerUserId).toBe(a.full.userId);
    expect(report.tenantId).toBe(a.tenantId);
    expect(report.status).toBe("active");
    expect(report.query.metricCodes).toEqual(["net_sales"]);
    expect(report.lastRunAt).toBeNull();
  });

  it("refuses a tenant id or owner in the body (strict schema)", async () => {
    const response = await create(a.full, {
      name: "x",
      query: QUERY,
      ownerUserId: a.peer.userId,
    });
    expect([400, 422]).toContain(response.status);
  });

  it("refuses a caller who may not read the query's metrics", async () => {
    expect((await create(a.nobody, { name: "x", query: QUERY })).status).toBe(
      403,
    );
  });

  it("refuses an outlet outside the caller's scope", async () => {
    const response = await create(a.outletManager, {
      name: "x",
      query: { ...QUERY, outletIds: [a.outlet2] },
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /api/reports/saved", () => {
  it("lists only the caller's own saved reports", async () => {
    const mine = await saved(a.full);
    const theirs = await saved(a.peer);
    const response = await list(a.full, "?limit=100");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const ids = savedReportPageSchema
      .parse(response.body)
      .data.map((row) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("pages with a cursor without repeating a row", async () => {
    for (let i = 0; i < 3; i += 1) await saved(a.outletManager);
    const first = savedReportPageSchema.parse(
      (await list(a.outletManager, "?limit=2")).body,
    );
    expect(first.data).toHaveLength(2);
    expect(first.meta.nextCursor).not.toBeNull();
    const second = savedReportPageSchema.parse(
      (
        await list(
          a.outletManager,
          `?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor ?? "")}`,
        )
      ).body,
    );
    const seen = new Set(first.data.map((row) => row.id));
    for (const row of second.data) expect(seen.has(row.id)).toBe(false);
  });

  it("never shows another tenant's saved reports", async () => {
    const other = await saved(b.full);
    const ids = savedReportPageSchema
      .parse((await list(a.full, "?limit=100")).body)
      .data.map((row) => row.id);
    expect(ids).not.toContain(other.id);
  });
});

describe("PATCH /api/reports/saved/:savedReportId", () => {
  it("renames and archives the owner's saved report", async () => {
    const report = await saved(a.full);
    const response = await patch(a.full, report.id, {
      name: "Nama baru",
      status: "archived",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const updated = savedReportSchema.parse(response.body.data);
    expect(updated.name).toBe("Nama baru");
    expect(updated.status).toBe("archived");
  });

  it("answers 404 for a peer's saved report in the same tenant", async () => {
    const report = await saved(a.peer);
    const response = await patch(a.full, report.id, { name: "Ambil alih" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("SAVED_REPORT_NOT_FOUND");
  });

  it("answers 404 for another tenant's saved report", async () => {
    const report = await saved(b.full);
    expect((await patch(a.full, report.id, { name: "x" })).status).toBe(404);
  });

  it("refuses a new query the caller may not read", async () => {
    const report = await saved(a.outletManager);
    const response = await patch(a.outletManager, report.id, {
      query: { ...QUERY, outletIds: [a.outlet2] },
    });
    expect(response.status).toBe(403);
  });

  it("answers 400/422 for an empty patch", async () => {
    const report = await saved(a.full);
    expect([400, 422]).toContain((await patch(a.full, report.id, {})).status);
  });
});
