// legend-ts50: RFM segment acceptance tests over HTTP (brief 290d "Tes gagal-dulu",
// bagian segmen; 304a). Contract: packages/shared/src/crm/endpoints.ts
// (listSegments, createSegment, previewSegment), crm.ts (segmentRuleSchema,
// segmentDefinitionSchema, segmentSchema, segmentPreviewSchema).
//
// Test ids: CRM-SEG-NN (no features.json exists, so the id is ours).
//
// Assumptions:
// - Spend and frequency come from customer_visits, recency from the latest
//   visit; the seeded data keeps the profile counters in step, so either reading
//   of "RFM input" gives the same answer.
// - Saving a segment (POST /api/segments) materializes it at once: the response
//   has size = preview size, refreshedAt set, and segment_members holds the
//   previewed customers. The daily worker job is not exercised here.
// - A customer who never visited is not asserted either way for inactive_days;
//   every seeded customer here has at least one visit.
// - An invalid definition is refused with 400 or 422 (shared strict schema).
// - Preview does not persist anything (no segments row, no segment_members).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { sql } from "drizzle-orm";
import type { segmentDefinitionSchema } from "@starter/shared/crm";
import type { z } from "zod";

// Wire shape (plain numbers), not the branded parsed type.
type SegmentDefinition = z.input<typeof segmentDefinitionSchema>;
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { originHeader } from "./helpers";
import {
  asTenant,
  newMemberUser,
  owner,
  rejection,
  seedMember,
} from "./member-loyalty-helpers.ts";
import {
  createCrmWorld,
  seedVisit,
  staffWith,
  type CrmStaff,
  type CrmWorld,
} from "./crm-customer360-helpers.ts";

let app: Express;
let world: CrmWorld;
let other: CrmWorld;
let manager: CrmStaff;
let noManage: CrmStaff;
let otherManager: CrmStaff;
let A: string; // 4 visits, last 2 days ago, 200k total
let B: string; // 1 visit 3 days ago, 300k
let C: string; // 3 visits 40-60 days ago, 60k
let foreignMatch: string; // matches every rule, but in the other tenant

const preview = (definition: SegmentDefinition) =>
  manager.client
    .post("/api/segments/preview")
    .set(world.host)
    .set(originHeader)
    .send({ definition });

const create = (
  name: string,
  definition: SegmentDefinition,
  staff: CrmStaff = manager,
  w: CrmWorld = world,
) =>
  staff.client
    .post("/api/segments")
    .set(w.host)
    .set(originHeader)
    .send({ name, definition });

const sampleIds = (body: { data: { sample: { id: string }[] } }) =>
  body.data.sample.map((p) => p.id).sort();

async function memberRows(tenantId: string, segmentId: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ customer_profile_id: string }>(
      "SELECT customer_profile_id FROM segment_members WHERE tenant_id = $1 AND segment_id = $2",
      [tenantId, segmentId],
    );
    return rows.map((r) => r.customer_profile_id).sort();
  });
}

beforeAll(async () => {
  app = createApp();
  world = await createCrmWorld();
  other = await createCrmWorld();
  manager = await staffWith(app, world, ["crm.segment.manage"], "Staf Segmen");
  noManage = await staffWith(app, world, ["crm.customer.view"], "Staf Lihat");
  otherManager = await staffWith(
    app,
    other,
    ["crm.segment.manage"],
    "Staf Segmen Lain",
  );

  A = (await seedMember(world.tenantId)).id;
  B = (await seedMember(world.tenantId)).id;
  C = (await seedMember(world.tenantId)).id;
  for (const [days, spend] of [
    [2, 50_000],
    [5, 50_000],
    [8, 50_000],
    [20, 50_000],
  ])
    await seedVisit(world, A, { daysAgo: days, spendIdr: spend });
  await seedVisit(world, B, { daysAgo: 3, spendIdr: 300_000 });
  for (const days of [40, 50, 60])
    await seedVisit(world, C, { daysAgo: days, spendIdr: 20_000 });

  foreignMatch = (await seedMember(other.tenantId)).id;
  for (const days of [1, 2, 3, 4])
    await seedVisit(other, foreignMatch, { daysAgo: days, spendIdr: 500_000 });
});

afterAll(async () => {
  await owner.end();
});

describe("CRM-SEG preview", () => {
  it("CRM-SEG-01 rfm_frequency returns customers with at least N visits", async () => {
    const response = await preview({
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 3 }],
    });
    expect(response.status).toBe(200);
    expect(response.body.data.size).toBe(2);
    expect(sampleIds(response.body)).toEqual([A, C].sort());
  });

  it("CRM-SEG-02 rfm_recency returns customers who visited within N days", async () => {
    const response = await preview({
      match: "all",
      rules: [{ kind: "rfm_recency", maxDaysSinceLastVisit: 10 }],
    });
    expect(response.status).toBe(200);
    expect(sampleIds(response.body)).toEqual([A, B].sort());
  });

  it("CRM-SEG-03 rfm_monetary returns customers whose spend reaches the minimum", async () => {
    const response = await preview({
      match: "all",
      rules: [{ kind: "rfm_monetary", minSpendIdr: 250_000 }],
    });
    expect(response.status).toBe(200);
    expect(sampleIds(response.body)).toEqual([B]);
  });

  it("CRM-SEG-04 inactive_days returns customers not seen for N days", async () => {
    const response = await preview({
      match: "all",
      rules: [{ kind: "inactive_days", days: 30 }],
    });
    expect(response.status).toBe(200);
    expect(sampleIds(response.body)).toEqual([C]);
  });

  it("CRM-SEG-05 match all intersects the rules, match any joins them", async () => {
    const all = await preview({
      match: "all",
      rules: [
        { kind: "rfm_frequency", minVisits: 3 },
        { kind: "rfm_recency", maxDaysSinceLastVisit: 10 },
      ],
    });
    expect(sampleIds(all.body)).toEqual([A]);
    const any = await preview({
      match: "any",
      rules: [
        { kind: "rfm_monetary", minSpendIdr: 250_000 },
        { kind: "inactive_days", days: 30 },
      ],
    });
    expect(sampleIds(any.body)).toEqual([B, C].sort());
  });

  it("CRM-SEG-06 empty state: a rule nobody meets previews size 0 and an empty sample", async () => {
    const response = await preview({
      match: "all",
      rules: [{ kind: "rfm_monetary", minSpendIdr: 900_000_000 }],
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ size: 0, sample: [] });
  });

  it("CRM-SEG-07 preview never includes another tenant's customers and saves nothing", async () => {
    const before = await asTenant(world.tenantId, (c) =>
      c.query("SELECT count(*)::int AS n FROM segments WHERE tenant_id = $1", [
        world.tenantId,
      ]),
    );
    const response = await preview({
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    });
    expect(sampleIds(response.body)).not.toContain(foreignMatch);
    expect(response.body.data.size).toBe(3);
    const after = await asTenant(world.tenantId, (c) =>
      c.query("SELECT count(*)::int AS n FROM segments WHERE tenant_id = $1", [
        world.tenantId,
      ]),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("CRM-SEG-08 an invalid definition (no rules, unknown rule, bad value) is refused", async () => {
    for (const definition of [
      { match: "all", rules: [] },
      { match: "all", rules: [{ kind: "rfm_frequency", minVisits: 0 }] },
      { match: "all", rules: [{ kind: "no_such_rule" }] },
      { match: "some", rules: [{ kind: "rfm_frequency", minVisits: 1 }] },
    ]) {
      const response = await manager.client
        .post("/api/segments/preview")
        .set(world.host)
        .set(originHeader)
        .send({ definition });
      expect([400, 422], JSON.stringify(definition)).toContain(response.status);
    }
  });
});

describe("CRM-SEG save and materialize", () => {
  it("CRM-SEG-09 a saved segment materializes exactly the previewed customers", async () => {
    const definition: SegmentDefinition = {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 3 }],
    };
    const previewed = await preview(definition);
    const created = await create(
      `Sering ${randomUUID().slice(0, 6)}`,
      definition,
    );
    expect(created.status).toBe(201);
    const segment = created.body.data;
    expect(segment.tenantId).toBe(world.tenantId);
    expect(segment.definition).toEqual(definition);
    expect(segment.size).toBe(previewed.body.data.size);
    expect(segment.refreshedAt).not.toBeNull();
    expect(await memberRows(world.tenantId, segment.id)).toEqual(
      sampleIds(previewed.body),
    );
  });

  it("CRM-SEG-10 the saved segment appears in the list with its size", async () => {
    const name = `Daftar ${randomUUID().slice(0, 6)}`;
    const created = await create(name, {
      match: "all",
      rules: [{ kind: "rfm_recency", maxDaysSinceLastVisit: 10 }],
    });
    expect(created.status).toBe(201);
    const list = await manager.client.get("/api/segments").set(world.host);
    expect(list.status).toBe(200);
    const found = (
      list.body.data as { id: string; name: string; size: number }[]
    ).find((s) => s.id === created.body.data.id);
    expect(found).toMatchObject({ name, size: 2 });
  });

  it("CRM-SEG-11 empty state: a tenant with no segments lists an empty page", async () => {
    const empty = await createCrmWorld();
    const staff = await staffWith(app, empty, ["crm.segment.manage"]);
    const list = await staff.client.get("/api/segments").set(empty.host);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });

  it("CRM-SEG-12 saving needs a name", async () => {
    const response = await create("", {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    });
    expect([400, 422]).toContain(response.status);
  });
});

describe("CRM-SEG access and tenant isolation", () => {
  it("CRM-SEG-13 staff without crm.segment.manage get 403 PERMISSION_DENIED on every segment route", async () => {
    const definition: SegmentDefinition = {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    };
    const calls = [
      noManage.client.get("/api/segments").set(world.host),
      noManage.client
        .post("/api/segments/preview")
        .set(world.host)
        .set(originHeader)
        .send({ definition }),
      noManage.client
        .post("/api/segments")
        .set(world.host)
        .set(originHeader)
        .send({ name: "Tidak boleh", definition }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
    }
  });

  it("CRM-SEG-14 a member session gets 403 and anonymous callers get 401", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const memberRead = await member.client.get("/api/segments").set(world.host);
    expect(memberRead.status).toBe(403);
    const anonymous = await request(app).get("/api/segments").set(world.host);
    expect(anonymous.status).toBe(401);
  });

  it("CRM-SEG-15 another tenant's staff see none of this tenant's segments or members", async () => {
    const created = await create(`Privat ${randomUUID().slice(0, 6)}`, {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    });
    expect(created.status).toBe(201);
    const list = await otherManager.client.get("/api/segments").set(other.host);
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((s) => s.id)).not.toContain(
      created.body.data.id,
    );
    // The other tenant previews only its own customer.
    const theirs = await otherManager.client
      .post("/api/segments/preview")
      .set(other.host)
      .set(originHeader)
      .send({
        definition: {
          match: "all",
          rules: [{ kind: "rfm_frequency", minVisits: 1 }],
        },
      });
    expect(sampleIds(theirs.body)).toEqual([foreignMatch]);
  });

  it("CRM-SEG-16 with the tenant GUC set, a raw select of another tenant's segments and members is empty", async () => {
    const created = await create(`Mentah ${randomUUID().slice(0, 6)}`, {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    });
    const segmentId = created.body.data.id as string;
    const count = (w: CrmWorld, query: ReturnType<typeof sql>) =>
      withTenant(db, w.context, async (tx) =>
        Number((await tx.execute(query)).rows[0]!.n),
      );
    for (const table of ["segments", "segment_members"]) {
      const column = table === "segments" ? "id" : "segment_id";
      const own = await count(
        world,
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${segmentId}`,
      );
      expect(own, `${table} visible to its tenant`).toBeGreaterThan(0);
      const foreign = await count(
        other,
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${segmentId}`,
      );
      expect(foreign, `${table} leaked`).toBe(0);
    }
  });

  it("CRM-SEG-17 a tenant cannot write a segment_members row for another tenant", async () => {
    const created = await create(`Tulis ${randomUUID().slice(0, 6)}`, {
      match: "all",
      rules: [{ kind: "rfm_frequency", minVisits: 1 }],
    });
    const segmentId = created.body.data.id as string;
    const message = await rejection(
      withTenant(db, other.context, (tx) =>
        tx.execute(sql`
          INSERT INTO segment_members (tenant_id, segment_id, customer_profile_id)
          VALUES (${world.tenantId}, ${segmentId}, ${A})`),
      ),
    );
    expect(message).toMatch(/row-level security|violates|permission denied/i);
  });
});
