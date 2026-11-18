// Brief 1059, architect finding 1: the training-device check of the door must
// not depend on the staff's outlet reach.
//
// A training device registered in outlet B is used by door staff whose scope is
// outlet A only. The device row of outlet B is invisible under outlet-A slicing;
// the check must still refuse (uniform 403 DOOR_CREDENTIAL_INVALID) and the
// ticket of outlet A must stay unopened. Control: a normal device opens it.

import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { owner as memberOwner, seedMember } from "./member-loyalty-helpers.ts";

const short = () => randomUUID().slice(0, 6);
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let outletB: string;
let trainingDeviceB: string;
let normalDeviceA: string;
let facilityId: string;
let areaId: string;
let productId: string;
let customerId: string;
let staffA: { client: ReturnType<typeof agent>; userId: string };
const devices = new Map<string, { tenantId: string; outletId: string }>();

async function register(id: string, outletId: string, label: string) {
  devices.set(id, { tenantId: tenant.tenantId, outletId });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId,
    deviceId: id,
    label,
  });
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`d59a-${short()}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    devices.get(deviceId)?.tenantId === tenantId
      ? (devices.get(deviceId)?.outletId ?? null)
      : null,
  );

  outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Arsitek', 'Jl. Uji 3', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `B${short()}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );

  trainingDeviceB = randomUUID();
  normalDeviceA = randomUUID();
  await register(trainingDeviceB, outletB, "Latihan B");
  await register(normalDeviceA, tenant.outletId, "Kasir A");
  await owner.query(
    "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, trainingDeviceB],
  );

  // Door staff whose role assignment reaches outlet A only.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Petugas Pintu A', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "facility.booth.operate",
        "facility.access.assist",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Petugas Pintu A");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, tenant.outletId],
  );
  staffA = { client, userId };

  facilityId = randomUUID();
  areaId = randomUUID();
  productId = randomUUID();
  customerId = (await seedMember(tenant.tenantId)).id;
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await db.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower Arsitek', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.tenantId,
        tenant.outletId,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await db.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Arsitek', 0)`,
      [areaId, tenant.tenantId, tenant.outletId, facilityId],
    );
    await db.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
       VALUES ($1, $2, $3, $4, 'Tiket Arsitek', 'single', 70000, 1, true, NULL)`,
      [productId, tenant.tenantId, tenant.outletId, facilityId],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}, 120_000);

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await memberOwner.end();
  await owner.end();
});

/** An issued ticket of outlet A with a live QR credential. */
async function issuedTicket(): Promise<{ ticketId: string; qrToken: string }> {
  const ticketId = randomUUID();
  const qrToken = `qr-${randomUUID()}`;
  const unitId = randomUUID();
  const start = new Date(Date.UTC(2035, 0, 2, 3));
  const end = new Date(start.getTime() + 20 * 60_000);
  const cleaningEnd = new Date(end.getTime() + 10 * 60_000);
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await db.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        unitId,
        tenant.tenantId,
        tenant.outletId,
        facilityId,
        areaId,
        `A-${short()}`.toUpperCase(),
      ],
    );
    await db.query(
      `INSERT INTO access_tickets
         (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id, product_id,
          source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, 'issued')`,
      [
        ticketId,
        tenant.tenantId,
        tenant.outletId,
        facilityId,
        areaId,
        unitId,
        customerId,
        productId,
        start,
        end,
        cleaningEnd,
      ],
    );
    await db.query(
      `INSERT INTO access_ticket_credentials
         (tenant_id, outlet_id, access_ticket_id, qr_digest, pin_digest, version,
          valid_from, valid_until, minted_key)
       VALUES ($1, $2, $3, $4, $5, 1, now() - interval '1 hour', now() + interval '2 hours', $6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        ticketId,
        sha256(qrToken),
        sha256(`${ticketId}:582914`),
        randomUUID(),
      ],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  return { ticketId, qrToken };
}

async function ticketRow(ticketId: string) {
  const { rows } = await owner.query<{
    status: string;
    first_opened_at: string | null;
  }>(
    `SELECT status, first_opened_at FROM access_tickets
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, ticketId],
  );
  return rows[0]!;
}

function doorCheck(qrToken: string, forDevice: string) {
  return staffA.client
    .post("/api/facility/tickets/door-check")
    .set(headers)
    .set(originHeader)
    .set(
      DEVICE_TOKEN_HEADER,
      signDeviceToken({
        version: 1,
        issuedAt: Math.floor(Date.now() / 1000),
        tenantId: tenant.tenantId,
        brandId: null,
        deviceId: forDevice,
      }),
    )
    .send({ facilityId, qrToken });
}

describe("architect finding 1: training device of another outlet", () => {
  it("arch-01 a training device registered in outlet B, used by staff scoped to outlet A only: uniform 403 and the ticket stays unopened", async () => {
    const { ticketId, qrToken } = await issuedTicket();
    const response = await doorCheck(qrToken, trainingDeviceB);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "DOOR_CREDENTIAL_INVALID",
    );
    const state = await ticketRow(ticketId);
    expect(state.status).toBe("issued");
    expect(state.first_opened_at).toBeNull();
  });

  it("arch-02 control: the same staff with a normal device of outlet A opens the ticket", async () => {
    const { ticketId, qrToken } = await issuedTicket();
    const response = await doorCheck(qrToken, normalDeviceA);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await ticketRow(ticketId)).status).toBe("in_use");
  });
});
