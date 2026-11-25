// legend-oaj3e: a stale device token is refused on the two remaining
// token-only routes (tier K access; PRD v1.7 §3 F5 Registri Perangkat, §3 F6,
// AUTH-06; same rule as the POS routes fixed in 386d490c and covered by
// device-token-rotation-replay.test.ts). A reissued device token replaces every
// older one: `devices.token_issued_at` moves, and a token whose `issuedAt` is
// before it, although correctly signed, is 401.
//
//   - POST /api/staff-pins/verify              (outlet screen, PIN check)
//   - POST /api/hris/attendance/outlet-clock   (outlet screen, clock with proof)
// while the NEWEST token of the same device keeps working.
//
// Assumptions where the card is silent:
// - Same harness and flow as edge-pin-proof.test.ts (verify on a cloud-style
//   app with purpose "attendance_clock", selfie upload and outlet-clock on the
//   edge app, attendance policy requires a selfie). Written from the card and
//   the contract, not from the implementation.
// - The device is enrolled, then its registry generation is set to 3 minutes
//   ago; old token = signed 2 minutes ago, new token = signed now after the
//   registry moved to 30 seconds ago (as in device-token-rotation-replay).
// - The refusal is HTTP 401 (no body code fixed), sent with the tenant's Host and has no side effect: no PIN
//   proof is issued by /verify and no attendance log is written by outlet-clock.
// - Clock refusal is asserted with a proof and selfie that are otherwise valid
//   (issued while the token was still current), so only the stale token can be
//   the reason.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import express from "express";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import sharp from "sharp";

// Must run before ../config/env is first imported (imports are hoisted).
const edgeDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "stale-token-"));
  process.env.EDGE_SELFIE_DIR = dir;
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000001.5d1e7c00-0000-4000-8000-000000000002.5d1e7c00-0000-4000-8000-000000000003." +
    "A".repeat(43);
  return dir;
});

import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  hashDeviceToken,
  signDeviceToken,
  verifyDeviceToken,
} from "../lib/device-token.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext as resolveTenantContext } from "../middleware/tenant.ts";
import { staffPinRouter } from "../routes/device-pin.routes.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  installEdgeNodeForTests,
  removeEdgeNodeForTests,
  withEdgeModeEnv,
} from "./edge-mode-env.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

// The clock attack uses the tenant's verified Host so a rotated-out token
// reaches that route instead of receiving 404 from token-only tenant resolution.
const DOMAIN_HOST = cafeLegendPlatformFixtures.domains[0].hostname;
const PROOF_HEADER = "X-Pin-Proof";
const PIN = "582914";
const KID = "stale-token-kid-1";

const edge = createApp({ edgeMode: true });
const cloud = createApp({ edgeMode: false });
delete process.env.EDGE_MODE;

// legend-or2pi Q55: isolate /verify's registry check from tenant resolution.
// Both tokens have the same Host and source=device, established from their real
// signatures. Production tenant resolution rejects stale tokens upstream; a
// domain-derived context instead hits the route's source guard for either token.
// Keep the real route, registry lookup and PIN/proof services below this seam.
const registryVerifyApp = express();
registryVerifyApp.use(requestContext);
registryVerifyApp.use(
  resolveTenantContext({
    resolveDomain: async () => null,
    verifyCredential: async (req) => {
      const raw = req.get(DEVICE_TOKEN_HEADER);
      const token = raw ? verifyDeviceToken(raw) : null;
      return token
        ? {
            tenantId: token.tenantId,
            brandId: token.brandId,
            source: "device" as const,
          }
        : null;
    },
  }),
);
registryVerifyApp.use("/api/staff-pins", staffPinRouter);
registryVerifyApp.use(errorHandler);

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdDevices: string[] = [];
let outletId: string;
let pepper: Buffer;
let image: Buffer;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const tokenOf = (deviceId: string, issuedAt: number) =>
  signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.id,
    brandId: null,
    deviceId,
  });

/** The registry row of the device's newest token: generation and digest (E2). */
async function issuedAs(deviceId: string, issuedAt: number): Promise<string> {
  const token = tokenOf(deviceId, issuedAt);
  await asTenant((c) =>
    c.query(
      "UPDATE devices SET token_issued_at = $3, token_hash = $4 WHERE id = $1 AND tenant_id = $2",
      [deviceId, tenant.id, new Date(issuedAt * 1000), hashDeviceToken(token)],
    ),
  );
  return token;
}

/** An enrolled device whose newest token is two minutes old. */
async function registeredDevice(label: string) {
  const enrolled = await enrollDevice(outletScope(outletId), actor, {
    outletId,
    type: "pos",
    label: `${label} ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  const id = enrolled.device.id;
  createdDevices.push(id);
  return { id, oldToken: await issuedAs(id, nowSeconds() - 120) };
}

/** Reissue: the registry generation moves on, every older token is replaced. */
async function rotate(deviceId: string): Promise<string> {
  return issuedAs(deviceId, nowSeconds());
}

async function newStaff(name: string) {
  const client = agent(cloud);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.id,
        `Token basi ${roleId.slice(0, 8)}`,
        JSON.stringify(["self.profile.view", "self.attendance.clock"]),
      ],
    );
    await c.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outletId],
    );
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Token Basi', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `TB-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
  });
  await setStaffPin(tenantContext, userId, { outletId, userId }, { pin: PIN });
  return { userId, employeeId };
}
type Staff = Awaited<ReturnType<typeof newStaff>>;

const verify = (token: string, userId: string, host?: string) =>
  agent(cloud)
    .post("/api/staff-pins/verify")
    .set(host ? { Host: host } : {})
    .set(DEVICE_TOKEN_HEADER, token)
    .send({ userId, pin: PIN, purpose: "attendance_clock" });

const verifyAtRegistry = (token: string, userId: string) =>
  agent(registryVerifyApp)
    .post("/api/staff-pins/verify")
    .set("Host", DOMAIN_HOST)
    .set(DEVICE_TOKEN_HEADER, token)
    .send({ userId, pin: PIN, purpose: "attendance_clock" });

async function issueProof(staff: Staff, token: string): Promise<string> {
  const response = await verify(token, staff.userId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data.proof as { token: string }).token;
}

const uploadSelfie = (proof: string, token: string) =>
  withEdgeModeEnv(async () =>
    agent(edge)
      .post("/api/storage/uploads")
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .set(PROOF_HEADER, proof)
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .attach("file", image, {
        filename: "selfie.jpg",
        contentType: "image/jpeg",
      }),
  );

const outletClock = (
  proof: string,
  token: string,
  photoUploadRef: string,
  host?: string,
) =>
  withEdgeModeEnv(async () =>
    agent(edge)
      .post("/api/hris/attendance/outlet-clock")
      .set(host ? { Host: host } : {})
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .set(PROOF_HEADER, proof)
      .send({
        type: "in",
        occurredAt: new Date().toISOString(),
        photoUploadRef,
        idempotencyKey: `att-stale-token-${randomUUID()}`,
      }),
  );

/** Proof and selfie issued with `token`, ready to clock with. */
async function readyToClock(staff: Staff, token: string) {
  const proof = await issueProof(staff, token);
  const upload = await uploadSelfie(proof, token);
  expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  return { proof, selfieId: upload.body.data.id as string };
}

async function proofRows(userId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id = $2",
    [tenant.id, userId],
  );
  return rows.length;
}

async function logRows(employeeId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM attendance_logs WHERE tenant_id = $1 AND employee_id = $2",
    [tenant.id, employeeId],
  );
  return rows.length;
}

function holdPepper() {
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.id, outletId, [{ version: 2, pepper }]);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  image = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "teal" },
  })
    .jpeg()
    .toBuffer();
  pepper = randomBytes(32);
  outletId = randomUUID();
  installEdgeNodeForTests({ tenantId: tenant.id, outletId: outletId });
  await asTenant((c) =>
    c.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet token basi', 'Jl. Token Basi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        outletId,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `TB-${outletId.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  holdPepper();
  await owner.query(
    `INSERT INTO edge_people_sync_state
       (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key, last_checked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [tenant.id, outletId, KID, publicKey],
  );

  const policyAdmin = agent(cloud);
  await signUp(policyAdmin, "Admin Kebijakan Token Basi");
  const session = await policyAdmin.get("/api/auth/get-session");
  const adminUserId = session.body.user.id as string;
  createdUsers.push(adminUserId);
  await verifySessionMfa(session.body.user.email as string);
  const adminRole = randomUUID();
  createdRoles.push(adminRole);
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Token basi admin', false, $3, false, '["tenant"]')`,
      [adminRole, tenant.id, JSON.stringify(["hr.attendance.manage"])],
    );
    await c.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenant.id, adminUserId, adminRole],
    );
  });
  const policy = await policyAdmin
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "reject",
        unboundDeviceAction: "reject",
        requireSelfie: true,
        requireDeviceBinding: true,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
}, 90_000);

afterEach(() => holdPepper());

afterAll(async () => {
  removeEdgeNodeForTests();
  resetEdgeStaffPinPeppers();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await asTenant(async (c) => {
    await c.query(
      "DELETE FROM staff_pin_proofs WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await c.query(
      "DELETE FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
      [tenant.id, createdDevices],
    );
    await c.query(
      "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await c.query(
      "DELETE FROM edge_selfie_uploads WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await c.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])",
      [tenant.id, createdEmployees],
    );
    await c.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    for (const table of ["attendance_logs", "shift_assignments"])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = $2`,
        [tenant.id, outletId],
      );
    await c.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await c.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-stale-token-%'",
      [tenant.id],
    );
    await c.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await c.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await c.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
  });
  await owner.end();
  rmSync(edgeDir, { recursive: true, force: true });
});

describe("legend-oaj3e POST /api/staff-pins/verify checks the device registry", () => {
  it("legend-oaj3e the old token is refused after rotation and issues no proof; the newest token verifies", async () => {
    const staff = await newStaff("Staf Verifikasi Basi");
    const device = await registeredDevice("Layar verifikasi");
    const fresh = await rotate(device.id);

    const replay = await verifyAtRegistry(device.oldToken, staff.userId);
    expect(replay.status, JSON.stringify(replay.body)).toBe(401);
    expect(replay.body.error.message).toBe(
      "Token perangkat ini tidak berlaku lagi. Daftarkan ulang perangkat.",
    );
    expect(await proofRows(staff.userId)).toBe(0);

    const current = await verifyAtRegistry(fresh, staff.userId);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(typeof current.body.data.proof.token).toBe("string");
  });

  it("legend-oaj3e a token that is still the latest (no rotation yet) verifies", async () => {
    const staff = await newStaff("Staf Verifikasi Segar");
    const device = await registeredDevice("Layar belum rotasi");
    const response = await verify(device.oldToken, staff.userId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});

describe("legend-oaj3e POST /api/hris/attendance/outlet-clock checks the device registry", () => {
  it("legend-oaj3e the old token is refused with an otherwise valid proof and selfie, and no log is written", async () => {
    const staff = await newStaff("Staf Absen Basi");
    const device = await registeredDevice("Layar absen basi");
    const ready = await readyToClock(staff, device.oldToken);
    await rotate(device.id);

    const replay = await outletClock(
      ready.proof,
      device.oldToken,
      ready.selfieId,
      DOMAIN_HOST,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(401);
    expect(await logRows(staff.employeeId)).toBe(0);
  });

  it("legend-oaj3e the newest token of the same device clocks in", async () => {
    const staff = await newStaff("Staf Absen Segar");
    const device = await registeredDevice("Layar absen segar");
    const fresh = await rotate(device.id);
    const ready = await readyToClock(staff, fresh);

    const response = await outletClock(ready.proof, fresh, ready.selfieId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await logRows(staff.employeeId)).toBe(1);
  });
});
