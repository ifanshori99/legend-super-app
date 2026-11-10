// WS-11 sales target API (bead legend-ne81z): per-outlet per-day targets, month
// spread, permissions, outlet and tenant isolation. Real Express app + Better
// Auth + RBAC + PostgreSQL (disposable server from `pnpm test`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { spreadMonthTarget } from "../services/sales-targets.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const base = (outlet: string) => `/api/outlets/${outlet}/sales-targets`;

let app: Express;
let admin: Staff; // owner, tenant scope: reads and writes every outlet
let managerA: Staff; // outlet manager of outlet A: reads, cannot write
let managerB: Staff; // outlet manager of outlet B only
let other: IsolatedTenant;
let otherStaff: Staff;

const get = (
  who: Staff,
  outlet: string,
  query = "from=2026-11-01&to=2026-11-30",
  host = seededHostname,
) => who.client.get(`${base(outlet)}?${query}`).set("Host", host);
const put = (
  who: Staff,
  outlet: string,
  body: unknown,
  path = "",
  host = seededHostname,
) =>
  who.client
    .put(base(outlet) + path)
    .set(originHeader)
    .set("Host", host)
    .send(body as object);

beforeAll(async () => {
  app = createApp();
  admin = await staffWithRole(app, { template: "owner", label: "ST Owner" });
  managerA = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletA,
    label: "ST Manager A",
  });
  managerB = await staffWithRole(app, {
    template: "outlet_manager",
    scopeType: "outlet",
    scopeId: seededOutletB,
    label: "ST Manager B",
  });
  other = await createIsolatedTenant(`st-${randomUUID().slice(0, 6)}`);
  otherStaff = await staffOfIsolatedTenant(app, other);
});

afterAll(async () => {
  await owner.query("DELETE FROM sales_targets WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    other.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("spreadMonthTarget", () => {
  it("adds up to the total and covers every day of the month", () => {
    const days = spreadMonthTarget("2026-02", 10_000_001);
    expect(days).toHaveLength(28);
    expect(days.reduce((sum, day) => sum + day.targetIdr, 0)).toBe(10_000_001);
    expect(days[0]?.targetDate).toBe("2026-02-01");
    expect(days[27]?.targetDate).toBe("2026-02-28");
    expect(
      Math.max(...days.map((d) => d.targetIdr)) -
        Math.min(...days.map((d) => d.targetIdr)),
    ).toBeLessThanOrEqual(1);
  });
  it("handles a 31-day month and a zero total", () => {
    expect(
      spreadMonthTarget("2026-12", 0).every((d) => d.targetIdr === 0),
    ).toBe(true);
    expect(spreadMonthTarget("2026-12", 3100)).toHaveLength(31);
  });
});

describe("sales targets API", () => {
  it("saves day targets, reads them back in date order, and upserts in place", async () => {
    const saved = await put(admin, seededOutletA, {
      targets: [
        { targetDate: "2026-11-03", targetIdr: 3_000_000 },
        { targetDate: "2026-11-01", targetIdr: 1_000_000 },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const read = await get(admin, seededOutletA);
    expect(read.status).toBe(200);
    expect(
      read.body.data.map((r: { targetDate: string }) => r.targetDate),
    ).toEqual(["2026-11-01", "2026-11-03"]);
    expect(read.body.data[1]).toMatchObject({
      outletId: seededOutletA,
      targetIdr: 3_000_000,
    });
    const again = await put(admin, seededOutletA, {
      targets: [{ targetDate: "2026-11-03", targetIdr: 3_500_000 }],
    });
    expect(again.status).toBe(200);
    const reread = await get(admin, seededOutletA);
    expect(reread.body.data).toHaveLength(2);
    expect(reread.body.data[1].targetIdr).toBe(3_500_000);
  });

  it("sets a month target spread evenly; the days add up to the total", async () => {
    const saved = await put(
      admin,
      seededOutletB,
      { month: "2026-10", targetIdr: 31_000_005 },
      "/month",
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toHaveLength(31);
    const read = await get(
      admin,
      seededOutletB,
      "from=2026-10-01&to=2026-10-31",
    );
    const total = read.body.data.reduce(
      (sum: number, r: { targetIdr: number }) => sum + r.targetIdr,
      0,
    );
    expect(total).toBe(31_000_005);
  });

  it("deletes a day (204), then 404 for the same day", async () => {
    await put(admin, seededOutletA, {
      targets: [{ targetDate: "2026-11-20", targetIdr: 1 }],
    });
    const del = await admin.client
      .delete(`${base(seededOutletA)}/2026-11-20`)
      .set(originHeader)
      .set("Host", seededHostname);
    expect(del.status).toBe(204);
    const again = await admin.client
      .delete(`${base(seededOutletA)}/2026-11-20`)
      .set(originHeader)
      .set("Host", seededHostname);
    expect(again.status).toBe(404);
  });

  it("an outlet manager reads its outlet but cannot write (403); the other outlet is 403", async () => {
    expect((await get(managerA, seededOutletA)).status).toBe(200);
    expect(
      (
        await put(managerA, seededOutletA, {
          targets: [{ targetDate: "2026-11-05", targetIdr: 1 }],
        })
      ).status,
    ).toBe(403);
    expect((await get(managerB, seededOutletA)).status).toBe(403);
    expect(
      (await get(managerA, seededOutletB, "from=2026-10-01&to=2026-10-31"))
        .status,
    ).toBe(403);
  });

  it("anonymous is 401", async () => {
    const res = await agent(app)
      .get(`${base(seededOutletA)}?from=2026-11-01&to=2026-11-30`)
      .set("Host", seededHostname);
    expect(res.status).toBe(401);
  });

  it("rejects bad input with 422 and stores nothing", async () => {
    for (const body of [
      { targets: [] },
      { targets: [{ targetDate: "2026-11-05", targetIdr: -1 }] },
      { targets: [{ targetDate: "2026-11-05", targetIdr: 1.5 }] },
      { targets: [{ targetDate: "2026-13-05", targetIdr: 1 }] },
      {
        targets: [
          { targetDate: "2026-11-05", targetIdr: 1 },
          { targetDate: "2026-11-05", targetIdr: 2 },
        ],
      },
      {
        targets: [{ targetDate: "2026-11-05", targetIdr: 1 }],
        outletId: seededOutletB,
      },
    ]) {
      expect((await put(admin, seededOutletA, body)).status).toBe(422);
    }
    expect(
      (
        await put(
          admin,
          seededOutletA,
          { month: "2026-13", targetIdr: 1 },
          "/month",
        )
      ).status,
    ).toBe(422);
    expect(
      (await get(admin, seededOutletA, "from=2026-11-30&to=2026-11-01")).status,
    ).toBe(422);
    expect(
      (await get(admin, seededOutletA, "from=2024-01-01&to=2026-11-30")).status,
    ).toBe(422);
    const read = await get(admin, seededOutletA);
    expect(
      read.body.data.find(
        (r: { targetDate: string }) => r.targetDate === "2026-11-05",
      ),
    ).toBeUndefined();
  });

  it("changing or deleting a past day's target refreshes the stored sales_target metric", async () => {
    const day = new Date(Date.now() - 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const stored = async () => {
      const { rows } = await owner.query<{ value_int: string }>(
        `SELECT value_int FROM metrics_daily
          WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
            AND metric_code = 'sales_target' AND dimension_key IS NULL`,
        [seededTenantId, seededOutletA, day],
      );
      return rows.map((row) => Number(row.value_int));
    };
    const saved = await put(admin, seededOutletA, {
      targets: [{ targetDate: day, targetIdr: 1_200_000 }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await stored()).toEqual([1_200_000]);
    const changed = await put(admin, seededOutletA, {
      targets: [{ targetDate: day, targetIdr: 2_400_000 }],
    });
    expect(changed.status).toBe(200);
    expect(await stored()).toEqual([2_400_000]);
    const del = await admin.client
      .delete(`${base(seededOutletA)}/${day}`)
      .set(originHeader)
      .set("Host", seededHostname);
    expect(del.status).toBe(204);
    expect(await stored()).toEqual([0]);
  });

  it("another tenant cannot read or write this outlet's targets", async () => {
    const read = await get(
      otherStaff,
      seededOutletA,
      undefined,
      other.hostname,
    );
    expect([403, 404]).toContain(read.status);
    const write = await put(
      otherStaff,
      seededOutletA,
      { targets: [{ targetDate: "2026-11-06", targetIdr: 9 }] },
      "",
      other.hostname,
    );
    expect([403, 404]).toContain(write.status);
    const { rows } = await owner.query(
      "SELECT 1 FROM sales_targets WHERE tenant_id = $1",
      [other.tenantId],
    );
    expect(rows).toHaveLength(0);
  });
});
