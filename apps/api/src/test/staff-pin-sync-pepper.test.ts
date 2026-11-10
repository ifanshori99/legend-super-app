// Staff pin sync export carries the outlet's DERIVED peppers (beads
// legend-ideif, legend-jmsdx; PRD v1.7 §3 F5 Server Lokal, §3 F6 "Staf — PIN
// Perangkat", EDG-02, TEN-02). An edge asks with `peppers=<versions it holds>`
// (`2,3`; empty = none); the cloud answers `meta.peppers` for the credential's
// outlet only (version >= 2), never version 1 and never the root secret.
// Assumption: an invalid query value is refused with 422, like the other
// invalid query values of this route (limit=0, revision=2); the brief said 400.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createStaffPinSyncRouter } from "../routes/staff-pin-sync.routes.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
  staffPinPeppersForEdge,
} from "../services/device-pin-pepper.ts";
import {
  listStaffPinRecordsSince,
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const otherOutletId = randomUUID();
const node: VerifiedEdgeNode = {
  tenantId,
  outletId: cafeLegendAccessFixtures.outletIds.bandung,
  edgeNodeId: randomUUID(),
};
const CREDENTIAL = `edge-${randomUUID()}`;
const path = "/api/edge-sync/staff-pin-records";
const bearer = { Authorization: `Bearer ${CREDENTIAL}` };

const app = express();
app.use(
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
  }),
);
app.use(path, createStaffPinSyncRouter({ perIp: 10_000, perNode: 10_000 }));
app.use(errorHandler);

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
  setEdgeCredentialVerifier(async ({ credential }) =>
    credential === CREDENTIAL ? node : null,
  );
});

afterAll(() => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
});

const outletId = node.outletId;

/** Versions in the page's peppers, ascending. */
const versionsOf = (page: { meta: { peppers?: Array<{ version: number }> } }) =>
  (page.meta.peppers ?? []).map((entry) => entry.version);

describe("legend-jmsdx staff pin sync export delivers the outlet pepper", () => {
  it("an empty holding lists the credential outlet's derived peppers, base64 of 32 bytes, never version 1", async () => {
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [],
    });
    const versions = versionsOf(page);
    expect(versions).toContain(currentStaffPinPepperVersion());
    expect(versions).not.toContain(1);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    for (const entry of page.meta.peppers ?? []) {
      expect(Buffer.from(entry.pepper, "base64")).toHaveLength(32);
      expect(
        Buffer.from(entry.pepper, "base64").equals(
          staffPinPepper(tenantId, outletId, entry.version),
        ),
      ).toBe(true);
    }
  });

  it("never carries another outlet's pepper", async () => {
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [],
    });
    const others = staffPinPeppersForEdge(
      tenantId,
      otherOutletId,
      [],
      [currentStaffPinPepperVersion()],
    ).map((entry) => entry.pepper);
    expect(others.length).toBeGreaterThan(0);
    for (const entry of page.meta.peppers ?? [])
      expect(others).not.toContain(entry.pepper);
  });

  it("without `peppers` the meta has no peppers key (an older edge parses meta strictly)", async () => {
    const page = await listStaffPinRecordsSince(node, { limit: 100 });
    expect(Object.keys(page.meta)).not.toContain("peppers");
    const response = await request(app).get(path).set(bearer);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.meta)).not.toContain("peppers");
  });

  it("an edge that holds every version it needs gets an empty list", async () => {
    const first = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [],
    });
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: versionsOf(first),
    });
    expect(page.meta.peppers).toEqual([]);
  });

  it("only sends the versions the edge lacks", async () => {
    const current = currentStaffPinPepperVersion();
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [current],
    });
    expect(versionsOf(page)).not.toContain(current);
  });

  it("over HTTP: peppers= (empty) answers 200, private and no-store, with the same peppers", async () => {
    const direct = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [],
    });
    const response = await request(app)
      .get(path)
      .query({ peppers: "" })
      .set(bearer);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.meta.peppers).toEqual(direct.meta.peppers);
  });

  it("over HTTP: peppers=none means nothing held, the same answer as the empty value", async () => {
    const direct = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: [],
    });
    const response = await request(app)
      .get(path)
      .query({ peppers: "none" })
      .set(bearer);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.meta.peppers).toEqual(direct.meta.peppers);
  });

  it("over HTTP: peppers=<list> parses the held versions", async () => {
    const current = currentStaffPinPepperVersion();
    const response = await request(app)
      .get(path)
      .query({ peppers: `${current}` })
      .set(bearer);
    expect(response.status).toBe(200);
    expect(
      (response.body.meta.peppers as Array<{ version: number }>).map(
        (entry) => entry.version,
      ),
    ).not.toContain(current);
  });

  it("the body never contains the root secret", async () => {
    const response = await request(app)
      .get(path)
      .query({ peppers: "" })
      .set(bearer);
    const body = response.text;
    expect(body).not.toContain("STAFF_PIN_PEPPER");
    expect(body).not.toContain("staff-pin-pepper-not-a-secret");
    const root = process.env.STAFF_PIN_PEPPER;
    if (root) {
      expect(body).not.toContain(root);
      expect(body).not.toContain(Buffer.from(root).toString("base64"));
    }
  });

  it("an invalid peppers value is refused with no pepper in the answer", async () => {
    const pepper = staffPinPeppersForEdge(
      tenantId,
      outletId,
      [],
      [currentStaffPinPepperVersion()],
    )[0]?.pepper;
    for (const value of ["-1", "abc", "1.5", "1001", "0", "2,,3", "2,x"]) {
      const response = await request(app)
        .get(path)
        .query({ peppers: value })
        .set(bearer);
      expect(response.status).toBe(422);
      if (pepper !== undefined) expect(response.text).not.toContain(pepper);
    }
  });

  it("no credential still answers 401, with no peppers", async () => {
    const response = await request(app).get(path).query({ peppers: "" });
    expect(response.status).toBe(401);
    expect(response.body.meta).toBeUndefined();
  });
});
