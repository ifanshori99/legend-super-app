// K0 (legend-wasr7.1, docs/design/cloud-only-release.md section 1): the
// EDGE_NODES_ENABLED switch. Off (the default), enrolling an edge node answers
// 403 FEATURE_DISABLED and writes nothing, so a stray enrol cannot make the
// cloud refuse sales at an outlet. Existing nodes keep their list, revoke and
// rotate routes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env.ts";
import { createApp } from "../app.ts";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";

const flag = env as unknown as { EDGE_NODES_ENABLED?: boolean };
const flagWas = flag.EDGE_NODES_ENABLED;
const app = createApp();
const label = `K0 switch ${Date.now()}`;
const outletId = randomUUID();
let admin: Staff;

const enroll = () =>
  admin.client
    .post("/api/edge-nodes")
    .set(originHeader)
    .send({ outletId, role: "primary", label });

const rows = async () =>
  (
    await owner.query(
      "SELECT 1 FROM edge_nodes WHERE tenant_id = $1 AND label = $2",
      [seededTenantId, label],
    )
  ).rowCount;

beforeAll(async () => {
  // A private outlet, so no other node of the seeded outlet gets in the way.
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji K0', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `K0${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  admin = await staffWithRole(app, { template: "owner" });
  await verifySessionMfa(admin.email);
});

afterEach(() => {
  flag.EDGE_NODES_ENABLED = flagWas;
});

describe("K0 EDGE_NODES_ENABLED", () => {
  it("is off by default", () => {
    expect(flagWas).toBe(false);
  });

  it("off: enrolling is refused with 403 FEATURE_DISABLED and writes nothing", async () => {
    flag.EDGE_NODES_ENABLED = false;
    const response = await enroll();
    expect(response.status).toBe(403);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "FEATURE_DISABLED",
    );
    expect(await rows()).toBe(0);
  });

  it("off: listing existing nodes still works", async () => {
    flag.EDGE_NODES_ENABLED = false;
    const response = await admin.client
      .get("/api/edge-nodes")
      .query({ outletId });
    expect(response.status).toBe(200);
  });

  it("on: enrolling answers 201 with the credential", async () => {
    flag.EDGE_NODES_ENABLED = true;
    const response = await enroll();
    expect(response.status).toBe(201);
    expect(await rows()).toBe(1);
  });
});
