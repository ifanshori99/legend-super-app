// Staff pin sync export carries the tenant's DERIVED peppers (bead legend-ideif;
// PRD v1.7 §3 F5 Server Lokal, §3 F6 "Staf — PIN Perangkat", EDG-02, TEN-02).
// An edge asks with `peppers=<highest version it holds>`; the cloud answers
// `meta.peppers` for the credential's tenant only, never the root secret.
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
const otherTenantId = randomUUID();
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

describe("legend-ideif staff pin sync export delivers the tenant pepper", () => {
  it("peppers=0 lists the credential tenant's derived peppers, base64 of 32 bytes", async () => {
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: 0,
    });
    const expected = staffPinPeppersForEdge(tenantId, 0);
    expect(expected.length).toBe(currentStaffPinPepperVersion());
    expect(page.meta.peppers).toEqual(expected);
    for (const entry of page.meta.peppers ?? []) {
      expect(Buffer.from(entry.pepper, "base64")).toHaveLength(32);
      expect(
        Buffer.from(entry.pepper, "base64").equals(
          staffPinPepper(tenantId, entry.version),
        ),
      ).toBe(true);
    }
  });

  it("never carries another tenant's pepper", async () => {
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: 0,
    });
    const others = staffPinPeppersForEdge(otherTenantId, 0).map(
      (entry) => entry.pepper,
    );
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

  it("an edge that already holds the current version gets an empty list", async () => {
    const page = await listStaffPinRecordsSince(node, {
      limit: 100,
      peppers: currentStaffPinPepperVersion(),
    });
    expect(page.meta.peppers).toEqual([]);
  });

  it("over HTTP: peppers=0 answers 200, private and no-store, with the same peppers", async () => {
    const response = await request(app)
      .get(path)
      .query({ peppers: 0 })
      .set(bearer);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.meta.peppers).toEqual(
      staffPinPeppersForEdge(tenantId, 0),
    );
  });

  it("the body never contains the root secret", async () => {
    const response = await request(app)
      .get(path)
      .query({ peppers: 0 })
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
    for (const value of ["-1", "abc", "1.5", "1001"]) {
      const response = await request(app)
        .get(path)
        .query({ peppers: value })
        .set(bearer);
      expect(response.status).toBe(422);
      expect(response.text).not.toContain(
        staffPinPeppersForEdge(tenantId, 0)[0]!.pepper,
      );
    }
  });

  it("no credential still answers 401, with no peppers", async () => {
    const response = await request(app).get(path).query({ peppers: 0 });
    expect(response.status).toBe(401);
    expect(response.body.meta).toBeUndefined();
  });
});
