// HTTP layer for the legend-cv3 routes (Opus review): tenant themes (TEN-10),
// text overrides (PRD v1.7 §3 F4 "Teks & Kamus Istilah") and versioned
// consents (LOY-04). Real Express app, Better Auth and PostgreSQL; service
// behaviour is covered by the *-db.test.ts suites, this file pins the route
// wiring: permission gate, strict bodies, status codes and the 422 contrast
// details.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const seededBrandId = cafeLegendPlatformFixtures.brand.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();
const createdThemeIds: string[] = [];
const subjectId = randomUUID();
// A key no other suite writes in the seeded tenant.
const overrideKey = "terms.showerRoom";

async function tenantMember(template: string, outletId?: string) {
  const client = agent(app);
  const email = await signUp(client, `Uji cv3 ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, $4, $5::uuid, now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = $3`,
    [
      seededTenantId,
      userId,
      template,
      outletId ? "outlet" : "tenant",
      outletId ?? null,
    ],
  );
  if (assigned.rowCount !== 1) throw new Error(`No ${template} role template`);
  await verifySessionMfa(email);
  return client;
}

afterAll(async () => {
  if (createdThemeIds.length)
    await owner.query(`DELETE FROM tenant_themes WHERE id = ANY($1::uuid[])`, [
      createdThemeIds,
    ]);
  await owner.query(
    `DELETE FROM text_overrides WHERE tenant_id = $1 AND key = $2 AND locale = 'en'`,
    [seededTenantId, overrideKey],
  );
  await owner.query(`DELETE FROM consents WHERE subject_id = $1`, [subjectId]);
  await owner.end();
});

describe("cv3 theme routes", () => {
  it("TEN-10 HTTP activation of a failing draft answers 422 with the failing pairs", async () => {
    const client = await tenantMember("tenant_admin");
    const created = await client
      .post("/api/org/themes")
      .set(originHeader)
      .send({
        brandId: seededBrandId,
        tokens: {
          light: { primary: "#f2f2f2", "primary-foreground": "#ffffff" },
          dark: {},
        },
        fontFamily: "inter",
        corners: "lembut",
      });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "draft",
      contrastCheckPassed: false,
    });
    createdThemeIds.push(created.body.data.id);

    const activated = await client
      .post(`/api/org/themes/${created.body.data.id}/activate`)
      .set(originHeader)
      .send({});
    expect(activated.status).toBe(422);
    expect(activated.body.error.code).toBe("THEME_CONTRAST_FAILED");
    expect(activated.body.error.details.length).toBeGreaterThan(0);
  });

  it("TEN-03 TEN-10 a role without org.theme.manage gets 403 and a forged tenantId is rejected", async () => {
    const cashier = await tenantMember("cashier");
    const denied = await cashier
      .get("/api/org/themes")
      .query({ brandId: seededBrandId });
    expect(denied.status).toBe(403);

    const admin = await tenantMember("tenant_admin");
    const forged = await admin
      .post("/api/org/themes")
      .set(originHeader)
      .send({
        tenantId: randomUUID(),
        brandId: seededBrandId,
        tokens: { light: {}, dark: {} },
        fontFamily: "inter",
        corners: "lembut",
      });
    expect(forged.status).toBe(422);
  });
});

describe("cv3 text override routes", () => {
  it("TEN-10 HTTP PUT versions an override and refuses unknown keys or a missing permission", async () => {
    const admin = await tenantMember("tenant_admin");
    const first = await admin
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({ locale: "en", key: overrideKey, value: "Shower" });
    expect(first.status).toBe(200);
    const second = await admin
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({ locale: "en", key: overrideKey, value: "Shower room" });
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(first.body.data.version + 1);

    const unknown = await admin
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({ locale: "en", key: "terms.doesNotExist", value: "x" });
    expect(unknown.status).toBe(422);

    const cashier = await tenantMember("cashier");
    const denied = await cashier
      .put("/api/org/text-overrides")
      .set(originHeader)
      .send({ locale: "en", key: overrideKey, value: "Nope" });
    expect(denied.status).toBe(403);
  });
});

describe("cv3 consent routes", () => {
  it("LOY-04 HTTP grant then withdraw appends rows; withdrawing nothing is 409", async () => {
    const client = await tenantMember("marketing");
    const body = {
      subjectId,
      purpose: "marketing",
      policyVersion: "2026-11",
      source: "cashier",
    };
    const nothing = await client
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, decision: "withdrawn" });
    expect(nothing.status).toBe(409);

    const granted = await client
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, decision: "granted" });
    expect(granted.status).toBe(201);
    const withdrawn = await client
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, decision: "withdrawn" });
    expect(withdrawn.status).toBe(201);

    const history = await client
      .get("/api/consents")
      .query({ subjectId, view: "history" });
    expect(history.status).toBe(200);
    expect(
      history.body.data.map((row: { decision: string }) => row.decision),
    ).toEqual(["withdrawn", "granted"]);
  });

  it("LOY-04 TEN-02 a body tenantId is rejected and a role without CRM access gets 403", async () => {
    const client = await tenantMember("marketing");
    const forged = await client.post("/api/consents").set(originHeader).send({
      tenantId: randomUUID(),
      subjectId,
      purpose: "ai",
      policyVersion: "2026-11",
      decision: "granted",
      source: "cashier",
    });
    expect(forged.status).toBe(422);

    const cashier = await tenantMember("cashier");
    const denied = await cashier
      .get("/api/consents")
      .query({ subjectId, view: "latest" });
    expect(denied.status).toBe(403);
  });
});

describe("ovi8 consent write permission", () => {
  const body = {
    subjectId,
    purpose: "ai",
    policyVersion: "2026-11",
    decision: "granted",
  };

  it("LOY-04 legend-ovi8 staff cannot claim member_pwa or website as the source", async () => {
    const client = await tenantMember("marketing");
    for (const source of ["member_pwa", "website"]) {
      const res = await client
        .post("/api/consents")
        .set(originHeader)
        .send({ ...body, source });
      expect(res.status).toBe(422);
    }
  });

  it("LOY-04 legend-ovi8 an outlet-scoped cashier records a cashier consent but not an import", async () => {
    const cashier = await tenantMember(
      "cashier",
      cafeLegendPlatformFixtures.outlets[0].id,
    );
    const imported = await cashier
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, source: "import" });
    expect(imported.status).toBe(403);
    const counter = await cashier
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, source: "cashier" });
    expect(counter.status).toBe(201);
  });

  it("LOY-04 legend-ovi8 a role without crm.consent.record gets 403 on POST", async () => {
    const waiter = await tenantMember(
      "waiter",
      cafeLegendPlatformFixtures.outlets[0].id,
    );
    const res = await waiter
      .post("/api/consents")
      .set(originHeader)
      .send({ ...body, source: "cashier" });
    expect(res.status).toBe(403);
  });
});
