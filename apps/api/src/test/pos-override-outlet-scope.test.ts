// GET /api/pos-overrides/:overrideId must respect the acting-staff token's
// outlet (bead legend-5u03q, S4). A staff member who works in outlets A and B
// and holds a token of A must not read or settle a pending override of B.
//
// Setup: the override row and its approval chain are seeded directly; the chain
// deadline is already past, so a request that reaches `settlePending` turns the
// row "expired" (visible as a status change). The refusal must therefore leave
// the row pending and the chain open.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, uuidToUlid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const [deviceA, deviceB, outletB, overrideId, chainId] = [1, 2, 3, 4, 5].map(
  () => randomUUID(),
) as [string, string, string, string, string];
const tillRole = randomUUID();

type Client = ReturnType<typeof agent>;
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: { client: Client; userId: string };
let staff: { userId: string };

const deviceToken = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function member(label: string) {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, tillRole],
  );
  return { client, userId };
}

async function tokenFor(deviceId: string): Promise<string> {
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ userId: staff.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

function getOverride(token: string, deviceId: string) {
  return sessionOwner.client
    .get(`/api/pos-overrides/${uuidToUlid(overrideId)}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .set(ACTING_HEADER, token);
}

async function overrideStatus() {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM pos_overrides WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, overrideId],
  );
  return rows[0]?.status;
}

async function chainStatus() {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chainId],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`ovsc-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    if (tenantId !== tenant.tenantId) return null;
    if (deviceId === deviceA) return tenant.outletId;
    if (deviceId === deviceB) return outletB;
    return null;
  });
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Override Scope', false, NULL, $3, false, '["tenant"]')`,
    [
      tillRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "shift.cash.operate",
        "pos.override.request",
      ]),
    ],
  );
  sessionOwner = await member("Sesi Login");
  staff = await member("Kasir Dua Outlet");
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Dua', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `OU2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const tenantCtx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const outletId of [tenant.outletId, outletB])
    await setStaffPin(
      tenantCtx,
      staff.userId,
      { outletId, userId: staff.userId },
      { pin: PIN },
    );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $3, $4, 'pos', 'Kasir A', now() - interval '1 minute'),
              ($2, $3, $5, 'pos', 'Kasir B', now() - interval '1 minute')`,
      [deviceA, deviceB, tenant.tenantId, tenant.outletId, outletB],
    );
    // Chain deadline already past: settling would flip the override to expired.
    await client.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
          object_id, payload, requested_by, source, level, required_levels,
          required_steps, status, request_reason, deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $1, 'pos_override', 'void', 'order', $4, '{}', $5, 'user',
               1, 1, '[]'::jsonb, 'pending', 'Uji lingkup outlet',
               now() - interval '1 hour', now() - interval '2 hours', now() - interval '2 hours')`,
      [chainId, tenant.tenantId, outletB, randomUUID(), staff.userId],
    );
    await client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, reason,
          value_idr, object_type, object_id, approval_request_id, request_fingerprint)
       VALUES ($1, $2, $3, 'void', 'supervisor_phone', 'pending', $4, 'Uji lingkup outlet',
               10000, 'order', $5, $6, $7)`,
      [
        overrideId,
        tenant.tenantId,
        outletB,
        staff.userId,
        randomUUID(),
        chainId,
        "0".repeat(64),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-5u03q GET /api/pos-overrides/:overrideId outlet scope", () => {
  it("a token of outlet A cannot read or settle a pending override of outlet B", async () => {
    const token = await tokenFor(deviceA);
    const response = await getOverride(token, deviceA);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.code).toBe("NOT_FOUND");
    expect(await overrideStatus()).toBe("pending");
    expect(await chainStatus()).toBe("pending");
  });

  it("a token of outlet B reads the override of outlet B", async () => {
    const token = await tokenFor(deviceB);
    const response = await getOverride(token, deviceB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.id).toBe(uuidToUlid(overrideId));
  });
});
