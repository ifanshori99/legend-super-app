// Reservation HTTP surface (PRD v1.7 §3.22; RSV-01..03; TEN-02/03; bead
// legend-t8bz). The router is mounted on a throwaway Express app so the test
// does not depend on the lead's routes/index.ts registration; auth, tenant
// resolution and RBAC are the real middleware against PostgreSQL.
import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { reservationRouter } from "../routes/reservation.routes";
import { agent } from "./helpers";
import {
  owner,
  seededHostname,
  seededOutletA,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

let app: ReturnType<typeof createApp>;
let staff: Staff;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The real app mounts everything but the reservation router (the lead's
  // wiring); route it explicitly in front of the app for this suite.
  const wrapper = express();
  const real = createApp();
  wrapper.use("/api", reservationRouter);
  wrapper.use(real);
  app = wrapper as unknown as ReturnType<typeof createApp>;
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv Api Owner",
  });
});

afterAll(async () => {
  await owner.end();
});

describe("reservation routes", () => {
  it("RSV-01 a public booking without an idempotency key is refused before anything is written", async () => {
    const response = await agent(app)
      .post(`/api/public/outlets/${seededOutletA}/reservations`)
      .set("Host", seededHostname)
      .send({
        reservedFor: new Date(Date.now() + 86_400_000 * 30).toISOString(),
        pax: 2,
        guestName: "Tamu",
        contactPhone: "081234567890",
      });
    expect(response.status).toBe(422);
  });

  it("RSV-01 a public booking body cannot carry a tenant or a DP amount (strict contract)", async () => {
    const response = await agent(app)
      .post(`/api/public/outlets/${seededOutletA}/reservations`)
      .set("Host", seededHostname)
      .set("Idempotency-Key", `rsv-${randomUUID()}`)
      .send({
        reservedFor: new Date(Date.now() + 86_400_000 * 30).toISOString(),
        pax: 2,
        guestName: "Tamu",
        contactPhone: "081234567890",
        depositIdr: 1,
        tenantId: randomUUID(),
      });
    expect(response.status).toBe(422);
  });

  it("RSV-02 RSV-03 staff routes need a session, an origin and the outlet permission", async () => {
    const anonymous = await agent(app).get(
      `/api/outlets/${seededOutletA}/reservations`,
    );
    expect(anonymous.status).toBe(401);
    const noOrigin = await staff.client
      .post(`/api/outlets/${seededOutletA}/reservations/${randomUUID()}/cancel`)
      .send({ reason: "x" });
    expect([401, 403]).toContain(noOrigin.status);
    const listed = await staff.client.get(
      `/api/outlets/${seededOutletA}/reservations`,
    );
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.data)).toBe(true);
  });
});
