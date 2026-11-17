// One-time PIN proof for outlet_device attendance on the edge (bead
// legend-u7g9w, found by the legend-j6cyb review; decision "Bukti PIN sekali
// pakai untuk absen outlet_device" in docs/DECISIONS.md). Criteria (a)-(k) of
// the card, one or more `it` per criterion, named by the criterion letter.
// (i) CORS preflight lives in pin-proof-cors.test.ts.
//
// The flow under test (the outlet screen): pick a name, type the PIN
// (POST /api/staff-pins/verify with purpose "attendance_clock"), receive a
// proof, upload the selfie with the proof (POST /api/storage/uploads), clock
// with the proof (POST /api/hris/attendance/outlet-clock). No session is
// needed. Written from the card and the decision, not from the implementation.
//
// Assumptions where the card is silent:
// - Headers: X-Device-Token (DEVICE_TOKEN_HEADER) and X-Pin-Proof. The proof
//   comes back as response.body.data.proof = { token, expiresAt }; the token
//   starts with "pp_"; TTL is 120 s.
// - Verify is requested on a cloud-style app (the PIN hash and the proof table
//   are the same shared test database); the outlet-clock and upload requests
//   run as the edge: createApp({ edgeMode: true }) plus EDGE_MODE=true around
//   the request (withEdgeModeEnv), like edge-attendance-clock.test.ts.
// - The outlet-clock body is { type, occurredAt, photoUploadRef,
//   idempotencyKey } and answers 201 with data.id of the new log; a replay with
//   the same proof owner + idempotencyKey answers 200 with the same data.id.
// - Expiry is simulated by moving the proof row's expires_at into the past
//   (and created_at before it). A proof is looked up by the device it was issued
//   to; "other device" = another registered device of the same outlet.
// - A wrong PIN is 401 PIN_INVALID (the existing verify contract). To stay
//   below the per-staff lockout (5 wrong), the device flood is spread across
//   three staff (4 + 4 + 2 wrong PINs = 10).
// - Throttle: the 10th wrong PIN still answers 401; the 11th request on that
//   device inside the window answers 429 PIN_DEVICE_THROTTLED with a
//   Retry-After of 1..300 seconds, whatever the PIN.
// - "Alert" = (legend-62jtd) one edge_to_cloud event staff_pin.device_throttled
//   in edge_outbound_queue for that device, queued when the 10th failure lands
//   and not queued again for the same window. The edge no longer writes a
//   local notification; the cloud applier notifies the supervisors (see
//   edge-staff-pin-throttle-alert.test.ts).
// - Audit: exactly one audit_logs row with action staff_pin.device_throttled
//   for the outlet or the device.
// - The log the staff clocks is read from attendance_logs by employee id; the
//   selfie owner from core_storage_objects.owner_user_id and
//   pin_proof_id (column added by this card).
// - "Role mfa_required" = a role row with mfa_required = true; the staff has
//   no MFA and no session at all in that flow.
// - GET /api/hris/attendance/logs with only the proof headers is checked on a
//   cloud-style app (route served there): 401, because a proof is not a session.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
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
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "edge-pin-proof-"));
  process.env.EDGE_SELFIE_DIR = dir;
  // The edge storage router is chosen from env.EDGE_MODE when createApp runs.
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000001.5d1e7c00-0000-4000-8000-000000000002.5d1e7c00-0000-4000-8000-000000000003." +
    "A".repeat(43);
  return dir;
});

// The supervisor alert can be made to fail (legend-u7g9w: a failing alert must
// not change the client's answer). Everything else passes through.
const alertFailure = vi.hoisted(() => ({ on: false }));
vi.mock("../services/edge-sync-conflict-alert.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/edge-sync-conflict-alert.ts")
    >();
  return {
    ...actual,
    notifyOutletSupervisors: (
      ...args: Parameters<typeof actual.notifyOutletSupervisors>
    ) => {
      if (alertFailure.on) throw new Error("alert channel down");
      return actual.notifyOutletSupervisors(...args);
    },
  };
});

import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
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
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  installEdgeNodeForTests,
  removeEdgeNodeForTests,
  withEdgeModeEnv,
} from "./edge-mode-env.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const PROOF_HEADER = "X-Pin-Proof";
const PIN = "582914";
const WRONG = "907153";
const PASSWORD = "Test-password-123!"; // the helpers.ts sign-up password
const KID = "pin-proof-kid-1";

const edge = createApp({ edgeMode: true });
const cloud = createApp({ edgeMode: false });
// From here on the process behaves as a cloud process unless a request is
// wrapped in withEdgeModeEnv (the apps above were built with EDGE_MODE on).
delete process.env.EDGE_MODE;

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
const createdOutlets: string[] = [];
const createdDevices: string[] = [];
let outletId: string; // O: where almost every test runs
let deviceToken: string; // D1 at O
let deviceId: string;
let secondDeviceToken: string; // D2 at O
let adminUserId: string;
let image: Buffer;

type Client = ReturnType<typeof agent>;

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

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
  mfaRequired = false,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5, $6)`,
      [
        roleId,
        tenant.id,
        `Pin proof ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        mfaRequired,
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "tenant" ? [null] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

// An edge node holds only its own outlet's peppers (legend-jmsdx). One pepper
// per outlet, kept for the whole file so a pin set earlier still verifies when
// the outlet is installed again.
const outletPeppers = new Map<string, Buffer>();

function holdEdgePepper(outlet: string) {
  let pepper = outletPeppers.get(outlet);
  if (pepper === undefined) {
    pepper = randomBytes(32);
    outletPeppers.set(outlet, pepper);
  }
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.id, outlet, [{ version: 2, pepper }]);
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Bukti PIN', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `PP-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    );
  });
  return id;
}

async function enrollAt(outlet: string, label: string) {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type: "pos",
    label: `${label} ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  createdDevices.push(enrolled.device.id);
  return { token: enrolled.token, id: enrolled.device.id };
}

type StaffOptions = {
  outlet?: string;
  status?: string;
  permissions?: string[];
  employee?: boolean;
  mfaRequired?: boolean;
};

/**
 * A staff member of an outlet with a PIN. By default also an active employee
 * with self.attendance.clock. `client` is the cloud-app agent signed in by the
 * sign-up (a "cashier session" on the shared screen).
 */
async function newStaff(name: string, options: StaffOptions = {}) {
  const outlet = options.outlet ?? outletId;
  const client = agent(cloud);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await grantRole(
    userId,
    options.permissions ?? ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: [outlet] },
    options.mfaRequired ?? false,
  );
  let employeeId: string | null = null;
  if (options.employee !== false) {
    employeeId = randomUUID();
    createdEmployees.push(employeeId);
    const id = employeeId;
    await asTenant(async (c) => {
      await c.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, 'Karyawan Bukti PIN', $5, 'pkwtt', '2025-03-01', $6)`,
        [
          id,
          tenant.id,
          userId,
          `PP-${id.slice(0, 8).toUpperCase()}`,
          outlet,
          options.status ?? "active",
        ],
      );
    });
  }
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: outlet, userId },
    { pin: PIN },
  );
  return { client, email, userId, employeeId };
}
type Staff = Awaited<ReturnType<typeof newStaff>>;

/** A supervisor of the outlet, so the alert has someone to reach. */
async function seedSupervisor(outlet: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Supervisor Bukti PIN', $2)`,
    [id, `${id}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, r.id, 'outlet', $3, now() - interval '1 hour', $2
       FROM roles r WHERE r.tenant_id = $1 AND r.template_key = 'supervisor'`,
    [tenant.id, id, outlet],
  );
  return id;
}

// ---- requests ---------------------------------------------------------------------

const verify = (
  token: string,
  userId: string,
  pin: string,
  purpose: "attendance_clock" | null = "attendance_clock",
) =>
  agent(cloud)
    .post("/api/staff-pins/verify")
    .set(DEVICE_TOKEN_HEADER, token)
    .send(purpose === null ? { userId, pin } : { userId, pin, purpose });

/** PIN verified with the attendance purpose: returns the proof token. */
async function issueProof(
  staff: Staff,
  token: string = deviceToken,
): Promise<string> {
  const response = await verify(token, staff.userId, PIN);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const proof = response.body.data.proof as { token: string };
  expect(typeof proof.token).toBe("string");
  return proof.token;
}

const uploadSelfie = (
  proof: string | null,
  options: { token?: string; client?: Client } = {},
) =>
  withEdgeModeEnv(async () => {
    let req = (options.client ?? agent(edge))
      .post("/api/storage/uploads")
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, options.token ?? deviceToken);
    if (proof !== null) req = req.set(PROOF_HEADER, proof);
    return await req
      .field("purpose", "selfie")
      .field("outletId", outletId)
      .attach("file", image, {
        filename: "selfie.jpg",
        contentType: "image/jpeg",
      });
  });

const clockBody = (overrides: Record<string, unknown> = {}) => ({
  type: "in",
  occurredAt: new Date().toISOString(),
  photoUploadRef: null,
  idempotencyKey: `att-pin-proof-${randomUUID()}`,
  ...overrides,
});

const outletClock = (
  proof: string | null,
  body: unknown,
  options: { token?: string | null; client?: Client } = {},
) =>
  withEdgeModeEnv(async () => {
    let req = (options.client ?? agent(edge))
      .post("/api/hris/attendance/outlet-clock")
      .set(originHeader);
    const token = options.token === undefined ? deviceToken : options.token;
    if (token !== null) req = req.set(DEVICE_TOKEN_HEADER, token);
    if (proof !== null) req = req.set(PROOF_HEADER, proof);
    return await req.send(body as object);
  });

/** Verify, upload the selfie, clock: the whole outlet screen flow. */
async function fullFlow(staff: Staff, body: Record<string, unknown> = {}) {
  const proof = await issueProof(staff);
  const upload = await uploadSelfie(proof);
  expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  const selfieId = upload.body.data.id as string;
  const response = await outletClock(
    proof,
    clockBody({ photoUploadRef: selfieId, ...body }),
  );
  return { proof, selfieId, response };
}

const codeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

// ---- database reads ---------------------------------------------------------------

const uuidOf = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : ulidToUuid(id);

async function logsOf(employeeId: string) {
  const { rows } = await owner.query<{ id: string; method: string }>(
    `SELECT id, method FROM attendance_logs
      WHERE tenant_id = $1 AND employee_id = $2 ORDER BY occurred_at`,
    [tenant.id, employeeId],
  );
  return rows;
}

async function pinRow(userId: string, outlet: string = outletId) {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenant.id, outlet, userId],
  );
  return rows[0];
}

async function proofRows(userId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id = $2",
    [tenant.id, userId],
  );
  return rows.length;
}

/** Moves every unused proof of the staff on the device into the past. */
async function expireProofs(userId: string, onDevice: string = deviceId) {
  const { rowCount } = await owner.query(
    `UPDATE staff_pin_proofs
        SET created_at = now() - interval '5 minutes',
            expires_at = now() - interval '1 minute'
      WHERE tenant_id = $1 AND device_id = $2 AND user_id = $3 AND consumed_at IS NULL`,
    [tenant.id, onDevice, userId],
  );
  expect(rowCount).toBeGreaterThan(0);
}

async function storageObject(objectId: string) {
  const { rows } = await owner.query<{
    owner_user_id: string | null;
    pin_proof_id: string | null;
  }>(
    "SELECT owner_user_id, pin_proof_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
    [tenant.id, uuidOf(objectId)],
  );
  return rows[0];
}

/**
 * Runs the process as a REGISTERED edge node of `outlet`: the throttle alert is
 * queued in edge_outbound_queue, which needs a real edge_nodes row (legend-62jtd).
 */
async function installRegisteredEdgeNode(outlet: string) {
  const registered = await registerEdgeNode(outletScope(outlet), actor, {
    outletId: outlet,
    role: "primary",
    label: `Edge throttle ${outlet.slice(0, 6)}`,
  });
  installEdgeNodeForTests({
    tenantId: tenant.id,
    outletId: outlet,
    edgeNodeId: registered.edgeNode.id,
  });
}

async function throttleAudits(outlet: string, device: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'staff_pin.device_throttled'
        AND (outlet_id = $2 OR event::text LIKE '%' || $3 || '%')`,
    [tenant.id, outlet, device],
  );
  return rows.length;
}

/** Queued edge_to_cloud staff_pin.device_throttled events of one device (legend-62jtd). */
async function throttleEvents(outlet: string, device: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM edge_outbound_queue
      WHERE tenant_id = $1 AND direction = 'edge_to_cloud'
        AND event->>'name' = 'staff_pin.device_throttled'
        AND event->>'outletId' = $2
        AND event->'payload'->>'deviceId' = $3`,
    [tenant.id, outlet, device],
  );
  return rows[0]!.n;
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
  outletId = await seedOutlet("Outlet bukti PIN");
  installEdgeNodeForTests({ tenantId: tenant.id, outletId: outletId });
  holdEdgePepper(outletId);
  const first = await enrollAt(outletId, "Layar satu");
  deviceToken = first.token;
  deviceId = first.id;
  const second = await enrollAt(outletId, "Layar dua");
  secondDeviceToken = second.token;

  // The edge roster copy: seal key for the selfie, checked just now.
  await owner.query(
    `INSERT INTO edge_people_sync_state
       (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key, last_checked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [tenant.id, outletId, KID, publicKey],
  );

  // Attendance policy: a selfie is required.
  const policyAdmin = agent(cloud);
  await signUp(policyAdmin, "Admin Kebijakan Bukti PIN");
  const session = await policyAdmin.get("/api/auth/get-session");
  adminUserId = session.body.user.id as string;
  createdUsers.push(adminUserId);
  await verifySessionMfa(session.body.user.email as string);
  await grantRole(adminUserId, ["hr.attendance.manage"], { type: "tenant" });
  const response = await policyAdmin
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
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}, 90_000);

afterEach(() => {
  holdEdgePepper(outletId);
});

afterAll(async () => {
  removeEdgeNodeForTests();
  resetEdgeStaffPinPeppers();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM staff_pin_proofs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
      [tenant.id, createdDevices],
    );
    await client.query(
      "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM edge_selfie_uploads WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    for (const table of ["attendance_logs", "shift_assignments"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-pin-proof-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets, devices, users and storage objects stay: audit_logs is
    // append-only and references them (disposable DB).
  });
  await owner.end();
  rmSync(edgeDir, { recursive: true, force: true });
});

// ---- (a) the log belongs to the PIN holder -----------------------------------------

describe("(a) the staff who typed the PIN is the staff who is clocked", () => {
  it("(a) cashier A's session cookie + staff B's proof -> the log is B's, not A's", async () => {
    const cashierA = await newStaff("Kasir A Sesi");
    const staffB = await newStaff("Staf B PIN");
    // A is signed in on the shared screen (the edge app).
    const sessionA = agent(edge);
    const signIn = await withEdgeModeEnv(async () =>
      sessionA
        .post("/api/auth/sign-in/email")
        .set(originHeader)
        .send({ email: cashierA.email, password: PASSWORD }),
    );
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);

    const proofB = await issueProof(staffB);
    const upload = await uploadSelfie(proofB, { client: sessionA });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const response = await outletClock(
      proofB,
      clockBody({ photoUploadRef: upload.body.data.id }),
      { client: sessionA },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const logsB = await logsOf(staffB.employeeId!);
    expect(logsB).toHaveLength(1);
    expect(logsB[0]!.method).toBe("outlet_device");
    expect(await logsOf(cashierA.employeeId!)).toHaveLength(0);
  });

  it("(a) verify with purpose returns a proof that lives 120 s; without purpose the answer has no proof", async () => {
    const staff = await newStaff("Staf Bentuk Bukti");
    const before = Date.now();
    const withPurpose = await verify(deviceToken, staff.userId, PIN);
    expect(withPurpose.status, JSON.stringify(withPurpose.body)).toBe(200);
    const proof = withPurpose.body.data.proof as {
      token: string;
      expiresAt: string;
    };
    expect(proof.token.startsWith("pp_")).toBe(true);
    const ttlMs = Date.parse(proof.expiresAt) - before;
    expect(ttlMs).toBeGreaterThan(110_000);
    expect(ttlMs).toBeLessThanOrEqual(125_000);
    expect(withPurpose.body.data).toMatchObject({
      outletId,
      user: { id: staff.userId },
    });

    // POS user switching keeps the old answer.
    const plain = await verify(deviceToken, staff.userId, PIN, null);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.data.proof).toBeUndefined();
    expect(plain.body.data).toMatchObject({
      outletId,
      user: { id: staff.userId },
    });
  });
});

// ---- (b) /clock refuses outlet_device ----------------------------------------------

describe("(b) clock with method outlet_device goes through outlet-clock only", () => {
  const oldBody = () => ({
    type: "in",
    method: "outlet_device",
    occurredAt: new Date().toISOString(),
    location: null,
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: `att-pin-proof-${randomUUID()}`,
  });

  it("(b) POST /clock on the edge -> 404 CLOUD_ONLY_ROUTE (the edge has no sessions) and no log", async () => {
    const staff = await newStaff("Staf Clock Lama Edge");
    const response = await withEdgeModeEnv(async () =>
      agent(edge)
        .post("/api/hris/attendance/clock")
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, deviceToken)
        .send(oldBody()),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(codeOf(response.body)).toBe("CLOUD_ONLY_ROUTE");
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
  });

  it("(b) POST /clock outlet_device on the cloud (session) -> 400 ATTENDANCE_METHOD_USE_OUTLET_CLOCK and no log", async () => {
    const staff = await newStaff("Staf Clock Lama Cloud");
    const response = await staff.client
      .post("/api/hris/attendance/clock")
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken)
      .send(oldBody());
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(codeOf(response.body)).toBe("ATTENDANCE_METHOD_USE_OUTLET_CLOCK");
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
  });
});

// ---- (c) one use -------------------------------------------------------------------

describe("(c) a proof clocks once", () => {
  it("(c) proof used twice -> 409 PIN_PROOF_USED; same idempotencyKey -> 200 old log", async () => {
    const staff = await newStaff("Staf Pakai Dua Kali");
    const key = `att-pin-proof-${randomUUID()}`;
    const proof = await issueProof(staff);
    const upload = await uploadSelfie(proof);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const body = clockBody({
      photoUploadRef: upload.body.data.id,
      idempotencyKey: key,
    });
    const first = await outletClock(proof, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // A different request with the used proof: refused.
    const second = await outletClock(
      proof,
      clockBody({
        type: "out",
        photoUploadRef: upload.body.data.id,
      }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(codeOf(second.body)).toBe("PIN_PROOF_USED");

    // The same request again (network retry): the old log, no new one.
    const replay = await outletClock(proof, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await logsOf(staff.employeeId!)).toHaveLength(1);
  });

  it("(c) a proof that clocked cannot upload another selfie", async () => {
    const staff = await newStaff("Staf Unggah Setelah Absen");
    const { proof, response } = await fullFlow(staff);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const late = await uploadSelfie(proof);
    expect(late.status, JSON.stringify(late.body)).toBe(401);
    expect(codeOf(late.body)).toBe("PIN_PROOF_INVALID");
  });
});

// ---- (d) wrong device, expired, unknown ---------------------------------------------

describe("(d) a proof from another device, expired or unknown is refused", () => {
  it("(d) proof issued on device 1 used on device 2 -> 401 PIN_PROOF_INVALID, nothing stored", async () => {
    const staff = await newStaff("Staf Perangkat Lain");
    const proof = await issueProof(staff, deviceToken);
    const upload = await uploadSelfie(proof);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const response = await outletClock(
      proof,
      clockBody({ photoUploadRef: upload.body.data.id }),
      { token: secondDeviceToken },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(codeOf(response.body)).toBe("PIN_PROOF_INVALID");
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
    // The proof was not burned by the wrong device: the right device still works.
    const right = await outletClock(
      proof,
      clockBody({ photoUploadRef: upload.body.data.id }),
    );
    expect(right.status, JSON.stringify(right.body)).toBe(201);
  });

  it("(d) proof older than 120 s -> 401 PIN_PROOF_INVALID on clock and on upload, nothing stored", async () => {
    const staff = await newStaff("Staf Bukti Kedaluwarsa");
    const proof = await issueProof(staff);
    const upload = await uploadSelfie(proof);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    await expireProofs(staff.userId);

    const lateUpload = await uploadSelfie(proof);
    expect(lateUpload.status, JSON.stringify(lateUpload.body)).toBe(401);
    expect(codeOf(lateUpload.body)).toBe("PIN_PROOF_INVALID");

    const response = await outletClock(
      proof,
      clockBody({ photoUploadRef: upload.body.data.id }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(codeOf(response.body)).toBe("PIN_PROOF_INVALID");
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
  });

  it("(d) missing or made-up proof header -> 401 PIN_PROOF_INVALID; a missing device token is not served", async () => {
    const staff = await newStaff("Staf Bukti Palsu");
    const selfie = await uploadSelfie(await issueProof(staff));
    expect(selfie.status, JSON.stringify(selfie.body)).toBe(201);
    const body = () => clockBody({ photoUploadRef: selfie.body.data.id });

    const none = await outletClock(null, body());
    expect(none.status, JSON.stringify(none.body)).toBe(401);
    expect(codeOf(none.body)).toBe("PIN_PROOF_INVALID");

    const empty = await outletClock("", body());
    expect(empty.status, JSON.stringify(empty.body)).toBe(401);
    expect(codeOf(empty.body)).toBe("PIN_PROOF_INVALID");

    const made = await outletClock(`pp_${"A".repeat(43)}`, body());
    expect(made.status, JSON.stringify(made.body)).toBe(401);
    expect(codeOf(made.body)).toBe("PIN_PROOF_INVALID");

    // Without a device token there is no tenant and no device: refused.
    const proof = await issueProof(staff);
    const noDevice = await outletClock(proof, body(), { token: null });
    expect(
      noDevice.status,
      JSON.stringify(noDevice.body),
    ).toBeGreaterThanOrEqual(400);
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
  });
});

// ---- (e) one live proof per device -----------------------------------------------------

describe("(e) a second proof on the same device ends the first", () => {
  it("(e) first proof after the second was issued -> 401; the second still clocks", async () => {
    const staffA = await newStaff("Staf A Bukti Pertama");
    const staffB = await newStaff("Staf B Bukti Kedua");
    const proofA = await issueProof(staffA);
    const uploadA = await uploadSelfie(proofA);
    expect(uploadA.status, JSON.stringify(uploadA.body)).toBe(201);
    // B starts while A's flow is not finished.
    const proofB = await issueProof(staffB);

    const aClock = await outletClock(
      proofA,
      clockBody({ photoUploadRef: uploadA.body.data.id }),
    );
    expect(aClock.status, JSON.stringify(aClock.body)).toBe(401);
    expect(codeOf(aClock.body)).toBe("PIN_PROOF_INVALID");
    expect(await logsOf(staffA.employeeId!)).toHaveLength(0);

    const uploadB = await uploadSelfie(proofB);
    expect(uploadB.status, JSON.stringify(uploadB.body)).toBe(201);
    const bClock = await outletClock(
      proofB,
      clockBody({ photoUploadRef: uploadB.body.data.id }),
    );
    expect(bClock.status, JSON.stringify(bClock.body)).toBe(201);
    expect(await logsOf(staffB.employeeId!)).toHaveLength(1);
    // A's correct PIN did not count as a failure.
    expect((await pinRow(staffA.userId))?.failed_attempts).toBe(0);
  });

  it("(e) the same staff asking again also ends their own first proof", async () => {
    const staff = await newStaff("Staf Minta Dua Kali");
    const first = await issueProof(staff);
    const second = await issueProof(staff);
    expect(second).not.toBe(first);
    const old = await uploadSelfie(first);
    expect(old.status, JSON.stringify(old.body)).toBe(401);
    expect(codeOf(old.body)).toBe("PIN_PROOF_INVALID");
    const fresh = await uploadSelfie(second);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
  });

  it("(e) two correct verifies at once on one device leave exactly one live proof", async () => {
    const device = await enrollAt(outletId, "Layar verify paralel");
    const staffA = await newStaff("Staf Paralel A");
    const staffB = await newStaff("Staf Paralel B");
    const answers = await Promise.all([
      verify(device.token, staffA.userId, PIN),
      verify(device.token, staffB.userId, PIN),
    ]);
    for (const response of answers)
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await owner.query(
      `SELECT 1 FROM staff_pin_proofs
        WHERE tenant_id = $1 AND device_id = $2
          AND consumed_at IS NULL AND expires_at > now()`,
      [tenant.id, device.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("(e) a proof on device 2 does not end the live proof on device 1", async () => {
    const staffA = await newStaff("Staf Perangkat Satu");
    const staffB = await newStaff("Staf Perangkat Dua");
    const proofA = await issueProof(staffA, deviceToken);
    await issueProof(staffB, secondDeviceToken);
    const upload = await uploadSelfie(proofA);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  });
});

// ---- (f) per-device throttle ----------------------------------------------------------

describe("(f) 10 wrong PINs from one device across staff", () => {
  // Each test runs as the edge node of its own outlet; back to outlet O after.
  afterEach(() => {
    installEdgeNodeForTests({ tenantId: tenant.id, outletId });
  });

  it("(f) 11th request -> 429 PIN_DEVICE_THROTTLED with Retry-After for that device only; one audit, one queued throttle event, staff counters untouched", async () => {
    const throttleOutlet = await seedOutlet("Outlet throttle PIN");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const flooded = await enrollAt(throttleOutlet, "Layar banjir");
    const calm = await enrollAt(throttleOutlet, "Layar tenang");
    await seedSupervisor(throttleOutlet);
    const options = { outlet: throttleOutlet };
    const staff1 = await newStaff("Staf Banjir Satu", options);
    const staff2 = await newStaff("Staf Banjir Dua", options);
    const staff3 = await newStaff("Staf Banjir Tiga", options);

    const wrong = async (staff: Staff, purpose: "attendance_clock" | null) => {
      const response = await verify(
        flooded.token,
        staff.userId,
        WRONG,
        purpose,
      );
      return response;
    };
    const expectWrongPin = async (
      staff: Staff,
      purpose: "attendance_clock" | null,
    ) => {
      const response = await wrong(staff, purpose);
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(codeOf(response.body)).toBe("PIN_INVALID");
    };

    const eventsAtStart = await throttleEvents(throttleOutlet, flooded.id);
    expect(eventsAtStart).toBe(0);
    // Wrong PINs 1..9: 4 for staff 1, 4 for staff 2, 1 for staff 3.
    for (let i = 0; i < 4; i += 1)
      await expectWrongPin(staff1, "attendance_clock");
    for (let i = 0; i < 4; i += 1)
      await expectWrongPin(staff2, "attendance_clock");
    await expectWrongPin(staff3, null);
    expect(await throttleAudits(throttleOutlet, flooded.id)).toBe(0);
    expect(await throttleEvents(throttleOutlet, flooded.id)).toBe(0);
    // The 10th wrong PIN is still an ordinary wrong PIN.
    await expectWrongPin(staff3, null);

    // The window now throttles the device: this window's single audit + a
    // single queued staff_pin.device_throttled event.
    expect(await throttleAudits(throttleOutlet, flooded.id)).toBe(1);
    expect(await throttleEvents(throttleOutlet, flooded.id)).toBe(1);

    const blockedWrong = await wrong(staff3, null);
    expect(blockedWrong.status, JSON.stringify(blockedWrong.body)).toBe(429);
    expect(codeOf(blockedWrong.body)).toBe("PIN_DEVICE_THROTTLED");
    const retryAfter = Number(blockedWrong.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(300);

    // Even a correct PIN on that device is refused, and issues no proof.
    const blockedRight = await verify(flooded.token, staff1.userId, PIN);
    expect(blockedRight.status, JSON.stringify(blockedRight.body)).toBe(429);
    expect(codeOf(blockedRight.body)).toBe("PIN_DEVICE_THROTTLED");
    expect(blockedRight.body.data).toBeUndefined();
    expect(await proofRows(staff1.userId)).toBe(0);
    const blockedAgain = await verify(
      flooded.token,
      staff2.userId,
      WRONG,
      null,
    );
    expect(blockedAgain.status, JSON.stringify(blockedAgain.body)).toBe(429);

    // Refused requests did not touch the staff counters, the audit, the alert.
    expect((await pinRow(staff3.userId, throttleOutlet))?.failed_attempts).toBe(
      2,
    );
    expect((await pinRow(staff2.userId, throttleOutlet))?.failed_attempts).toBe(
      4,
    );
    expect(await throttleAudits(throttleOutlet, flooded.id)).toBe(1);
    expect(await throttleEvents(throttleOutlet, flooded.id)).toBe(1);
    // The calm device of the same outlet queued no throttle event.
    expect(await throttleEvents(throttleOutlet, calm.id)).toBe(0);

    // Another device of the same outlet keeps working: right and wrong PIN.
    const okElsewhere = await verify(calm.token, staff1.userId, PIN);
    expect(okElsewhere.status, JSON.stringify(okElsewhere.body)).toBe(200);
    expect(typeof okElsewhere.body.data.proof.token).toBe("string");
    const wrongElsewhere = await verify(calm.token, staff3.userId, WRONG, null);
    expect(wrongElsewhere.status, JSON.stringify(wrongElsewhere.body)).toBe(
      401,
    );
    expect(codeOf(wrongElsewhere.body)).toBe("PIN_INVALID");
  });

  it("(f) 20 wrong PINs at once from one device -> at most 10 answer 401, the rest 429, staff counters rise by at most 10", async () => {
    const throttleOutlet = await seedOutlet("Outlet salah serentak");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const device = await enrollAt(throttleOutlet, "Layar serentak");
    const options = { outlet: throttleOutlet };
    const crowd: Staff[] = [];
    // 7 staff x at most 3 wrong PINs each stays below the per-staff lockout.
    for (let i = 0; i < 7; i += 1)
      crowd.push(await newStaff(`Staf Serentak ${i + 1}`, options));
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        verify(device.token, crowd[i % crowd.length]!.userId, WRONG, null),
      ),
    );
    const invalid = answers.filter((r) => r.status === 401);
    const throttled = answers.filter((r) => r.status === 429);
    for (const response of invalid)
      expect(codeOf(response.body)).toBe("PIN_INVALID");
    for (const response of throttled)
      expect(codeOf(response.body)).toBe("PIN_DEVICE_THROTTLED");
    expect(invalid.length, JSON.stringify(answers.map((r) => r.status))).toBe(
      10,
    );
    expect(throttled).toHaveLength(10);
    let rise = 0;
    for (const staff of crowd)
      rise +=
        (await pinRow(staff.userId, throttleOutlet))?.failed_attempts ?? 0;
    expect(rise).toBeLessThanOrEqual(10);
    expect(await throttleAudits(throttleOutlet, device.id)).toBe(1);
    // 20 concurrent requests, one window: exactly one throttle event, no double.
    expect(await throttleEvents(throttleOutlet, device.id)).toBe(1);
  });

  it("(f) a failing alert does not change the answers: 10th wrong PIN stays 401, 11th stays 429", async () => {
    const throttleOutlet = await seedOutlet("Outlet alarm gagal");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const device = await enrollAt(throttleOutlet, "Layar alarm gagal");
    await seedSupervisor(throttleOutlet);
    const options = { outlet: throttleOutlet };
    const staff1 = await newStaff("Staf Alarm Satu", options);
    const staff2 = await newStaff("Staf Alarm Dua", options);
    const staff3 = await newStaff("Staf Alarm Tiga", options);
    alertFailure.on = true;
    try {
      for (const [staff, times] of [
        [staff1, 4],
        [staff2, 4],
        [staff3, 2],
      ] as const)
        for (let i = 0; i < times; i += 1) {
          const response = await verify(
            device.token,
            staff.userId,
            WRONG,
            null,
          );
          expect(response.status, JSON.stringify(response.body)).toBe(401);
          expect(codeOf(response.body)).toBe("PIN_INVALID");
        }
      const blocked = await verify(device.token, staff1.userId, WRONG, null);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
      expect(codeOf(blocked.body)).toBe("PIN_DEVICE_THROTTLED");
    } finally {
      alertFailure.on = false;
    }
  });

  it("(f) legend-sp9vq: guesses that newly lock a staff PIN still count on the device; an already locked PIN does not", async () => {
    const throttleOutlet = await seedOutlet("Outlet kunci baru");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const device = await enrollAt(throttleOutlet, "Layar kunci baru");
    await seedSupervisor(throttleOutlet);
    const options = { outlet: throttleOutlet };
    const crowd: Staff[] = [];
    for (let i = 0; i < 12; i += 1)
      crowd.push(await newStaff(`Staf Kunci ${i + 1}`, options));
    // Each staff sits at 4 wrong PINs (as after earlier device windows): the
    // next wrong guess is the 5th and locks the PIN.
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 4
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
      [tenant.id, throttleOutlet, crowd.map((s) => s.userId)],
    );
    for (const staff of crowd.slice(0, 10)) {
      const response = await verify(device.token, staff.userId, WRONG, null);
      expect(response.status, JSON.stringify(response.body)).not.toBe(429);
      expect(codeOf(response.body)).toBe("PIN_LOCKED");
    }
    // 10 locking guesses used the 10 device slots: the 11th is refused 429
    // before any staff counter moves, and the window event was queued once.
    const blocked = await verify(device.token, crowd[10]!.userId, WRONG, null);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(codeOf(blocked.body)).toBe("PIN_DEVICE_THROTTLED");
    expect(
      (await pinRow(crowd[10]!.userId, throttleOutlet))?.failed_attempts,
    ).toBe(4);
    expect(await throttleAudits(throttleOutlet, device.id)).toBe(1);
    expect(await throttleEvents(throttleOutlet, device.id)).toBe(1);

    // A PIN that was already locked never looks at the guess: it gives the
    // slot back, so on a calm device many tries stay PIN_LOCKED.
    const calm = await enrollAt(throttleOutlet, "Layar sudah terkunci");
    for (let i = 0; i < 15; i += 1) {
      const response = await verify(calm.token, crowd[0]!.userId, WRONG, null);
      expect(response.status, JSON.stringify(response.body)).not.toBe(429);
      expect(codeOf(response.body)).toBe("PIN_LOCKED");
    }
  });

  it("(f) legend-sp9vq: 12 locking guesses at once -> exactly 10 answer PIN_LOCKED, 2 answer 429", async () => {
    const throttleOutlet = await seedOutlet("Outlet kunci serentak");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const device = await enrollAt(throttleOutlet, "Layar kunci serentak");
    const options = { outlet: throttleOutlet };
    const crowd: Staff[] = [];
    for (let i = 0; i < 12; i += 1)
      crowd.push(await newStaff(`Staf Serentak Kunci ${i + 1}`, options));
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 4
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
      [tenant.id, throttleOutlet, crowd.map((s) => s.userId)],
    );
    const answers = await Promise.all(
      crowd.map((s) => verify(device.token, s.userId, WRONG, null)),
    );
    const statuses = JSON.stringify(answers.map((r) => r.status));
    expect(answers.filter((r) => r.status === 423).length, statuses).toBe(10);
    expect(answers.filter((r) => r.status === 429).length, statuses).toBe(2);
  });

  it("(f) 9 wrong PINs do not throttle: the next correct PIN still works", async () => {
    const throttleOutlet = await seedOutlet("Outlet sembilan salah");
    await installRegisteredEdgeNode(throttleOutlet);
    holdEdgePepper(throttleOutlet);
    const device = await enrollAt(throttleOutlet, "Layar sembilan");
    const options = { outlet: throttleOutlet };
    const staff1 = await newStaff("Staf Sembilan Satu", options);
    const staff2 = await newStaff("Staf Sembilan Dua", options);
    const staff3 = await newStaff("Staf Sembilan Tiga", options);
    for (const [staff, times] of [
      [staff1, 4],
      [staff2, 4],
      [staff3, 1],
    ] as const)
      for (let i = 0; i < times; i += 1) {
        const response = await verify(device.token, staff.userId, WRONG, null);
        expect(response.status, JSON.stringify(response.body)).toBe(401);
      }
    const ok = await verify(device.token, staff3.userId, PIN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await throttleAudits(throttleOutlet, device.id)).toBe(0);
  });
});

// ---- (g) mfa_required roles --------------------------------------------------------------

describe("(g) a staff role with mfa_required clocks with PIN + selfie only", () => {
  it("(g) verify, upload and outlet-clock succeed without a session or TOTP", async () => {
    const manager = await newStaff("Manajer Tanpa TOTP", {
      mfaRequired: true,
    });
    const { response } = await fullFlow(manager);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(manager.employeeId!);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.method).toBe("outlet_device");
  });

  it("(g) the proof is not a session: GET /api/hris/attendance/logs with the proof headers only -> 401", async () => {
    const manager = await newStaff("Manajer Bukan Sesi", { mfaRequired: true });
    const proof = await issueProof(manager);
    const response = await agent(cloud)
      .get("/api/hris/attendance/logs")
      .set(DEVICE_TOKEN_HEADER, deviceToken)
      .set(PROOF_HEADER, proof);
    expect(response.status, JSON.stringify(response.body)).toBe(401);
  });
});

// ---- (h) selfie bound to the proof -----------------------------------------------------

describe("(h) the selfie belongs to the proof", () => {
  it("(h) a selfie uploaded with another proof -> 400 SELFIE_NOT_FROM_PROOF, nothing stored", async () => {
    const staffA = await newStaff("Staf Selfie Pemilik");
    const staffB = await newStaff("Staf Selfie Tempel");

    // Another person's selfie, pasted on B's clock.
    const proofA = await issueProof(staffA);
    const selfieA = await uploadSelfie(proofA);
    expect(selfieA.status, JSON.stringify(selfieA.body)).toBe(201);
    const proofB = await issueProof(staffB);
    const pasted = await outletClock(
      proofB,
      clockBody({ photoUploadRef: selfieA.body.data.id }),
    );
    expect(pasted.status, JSON.stringify(pasted.body)).toBe(400);
    expect(codeOf(pasted.body)).toBe("SELFIE_NOT_FROM_PROOF");
    expect(await logsOf(staffB.employeeId!)).toHaveLength(0);
    expect(await logsOf(staffA.employeeId!)).toHaveLength(0);
  });

  it("(h) the same staff's selfie from an earlier proof is not accepted either", async () => {
    const staff = await newStaff("Staf Selfie Proof Lama");
    const first = await issueProof(staff);
    const oldSelfie = await uploadSelfie(first);
    expect(oldSelfie.status, JSON.stringify(oldSelfie.body)).toBe(201);
    const second = await issueProof(staff);
    const response = await outletClock(
      second,
      clockBody({ photoUploadRef: oldSelfie.body.data.id }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(codeOf(response.body)).toBe("SELFIE_NOT_FROM_PROOF");
    expect(await logsOf(staff.employeeId!)).toHaveLength(0);
  });

  it("(h) upload with a used, expired or ended proof -> 401 PIN_PROOF_INVALID", async () => {
    const used = await newStaff("Staf Unggah Terpakai");
    const flow = await fullFlow(used);
    expect(flow.response.status, JSON.stringify(flow.response.body)).toBe(201);
    const afterUse = await uploadSelfie(flow.proof);
    expect(afterUse.status, JSON.stringify(afterUse.body)).toBe(401);
    expect(codeOf(afterUse.body)).toBe("PIN_PROOF_INVALID");

    const ended = await newStaff("Staf Unggah Diakhiri");
    const endedProof = await issueProof(ended);
    await issueProof(await newStaff("Staf Penyela Unggah"));
    const afterEnd = await uploadSelfie(endedProof);
    expect(afterEnd.status, JSON.stringify(afterEnd.body)).toBe(401);
    expect(codeOf(afterEnd.body)).toBe("PIN_PROOF_INVALID");

    const stale = await newStaff("Staf Unggah Basi");
    const staleProof = await issueProof(stale);
    await expireProofs(stale.userId);
    const afterExpiry = await uploadSelfie(staleProof);
    expect(afterExpiry.status, JSON.stringify(afterExpiry.body)).toBe(401);
    expect(codeOf(afterExpiry.body)).toBe("PIN_PROOF_INVALID");

    const otherDevice = await newStaff("Staf Unggah Perangkat Lain");
    const otherProof = await issueProof(otherDevice);
    const wrongDevice = await uploadSelfie(otherProof, {
      token: secondDeviceToken,
    });
    expect(wrongDevice.status, JSON.stringify(wrongDevice.body)).toBe(401);
    expect(codeOf(wrongDevice.body)).toBe("PIN_PROOF_INVALID");
  });

  it("(h) the stored selfie is owned by the proof's staff, whatever session the screen holds", async () => {
    const cashier = await newStaff("Kasir Pemilik Sesi");
    const staff = await newStaff("Staf Pemilik Selfie");
    const session = agent(edge);
    const signIn = await withEdgeModeEnv(async () =>
      session
        .post("/api/auth/sign-in/email")
        .set(originHeader)
        .send({ email: cashier.email, password: PASSWORD }),
    );
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);

    const proof = await issueProof(staff);
    const upload = await uploadSelfie(proof, { client: session });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const stored = await storageObject(upload.body.data.id as string);
    expect(stored?.owner_user_id).toBe(staff.userId);
    expect(stored?.owner_user_id).not.toBe(cashier.userId);
    expect(stored?.pin_proof_id).not.toBeNull();
  });
});

// ---- (j) who may ask for a proof ----------------------------------------------------------

describe("(j) a user who may not clock gets 403 ATTENDANCE_NOT_ALLOWED before the PIN is checked", () => {
  async function expectNotAllowed(staff: Staff) {
    for (const pin of [PIN, WRONG]) {
      const response = await verify(deviceToken, staff.userId, pin);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(codeOf(response.body)).toBe("ATTENDANCE_NOT_ALLOWED");
      expect(response.body.data).toBeUndefined();
    }
    expect((await pinRow(staff.userId))?.failed_attempts).toBe(0);
    expect(await proofRows(staff.userId)).toBe(0);
  }

  it("(j) role without self.attendance.clock", async () => {
    const staff = await newStaff("Staf Tanpa Izin Absen", {
      permissions: ["self.profile.view"],
    });
    await expectNotAllowed(staff);
  });

  it("(j) not an employee at all; the plain verify for POS switching still works", async () => {
    const cashier = await newStaff("Kasir Bukan Karyawan", { employee: false });
    await expectNotAllowed(cashier);
    const plain = await verify(deviceToken, cashier.userId, PIN, null);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.data.proof).toBeUndefined();
  });

  it("(j) suspended employee", async () => {
    const staff = await newStaff("Karyawan Ditangguhkan", {
      status: "suspended",
    });
    await expectNotAllowed(staff);
  });

  it("(j) an onboarding employee may ask for a proof", async () => {
    const staff = await newStaff("Karyawan Onboarding", {
      status: "onboarding",
    });
    const response = await verify(deviceToken, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.proof.token.startsWith("pp_")).toBe(true);
  });
});

// ---- (k) retry with somebody else's idempotency key ----------------------------------------

describe("(k) a proof never opens another staff member's log", () => {
  it("(k) staff A's proof + staff B's idempotencyKey -> not B's log, B's log untouched", async () => {
    const staffA = await newStaff("Staf A Kunci Orang");
    const staffB = await newStaff("Staf B Kunci Asli");
    const key = `att-pin-proof-${randomUUID()}`;
    const first = await fullFlow(staffB, { idempotencyKey: key });
    expect(first.response.status, JSON.stringify(first.response.body)).toBe(
      201,
    );
    const bLogId = first.response.body.data.id as string;

    const proofA = await issueProof(staffA);
    const uploadA = await uploadSelfie(proofA);
    expect(uploadA.status, JSON.stringify(uploadA.body)).toBe(201);
    const attempt = await outletClock(
      proofA,
      clockBody({
        photoUploadRef: uploadA.body.data.id,
        idempotencyKey: key,
      }),
    );
    expect(attempt.status, JSON.stringify(attempt.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(codeOf(attempt.body)).toBe("IDEMPOTENCY_KEY_REUSED");
    // Nothing of B's log is in the answer.
    expect(JSON.stringify(attempt.body)).not.toContain(bLogId);
    expect(await logsOf(staffA.employeeId!)).toHaveLength(0);
    const logsB = await logsOf(staffB.employeeId!);
    expect(logsB).toHaveLength(1);
    expect(logsB[0]!.id).toBe(uuidOf(bLogId));
  });

  it("(k) the proof holder replaying their own key gets the old log; the same key for another type is refused", async () => {
    const staff = await newStaff("Staf Ulang Sendiri");
    const key = `att-pin-proof-${randomUUID()}`;
    const proof = await issueProof(staff);
    const upload = await uploadSelfie(proof);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const body = clockBody({
      photoUploadRef: upload.body.data.id,
      idempotencyKey: key,
    });
    const first = await outletClock(proof, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await outletClock(proof, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    // Same key, different type: not the same request.
    const changed = await outletClock(proof, { ...body, type: "out" });
    expect(changed.status, JSON.stringify(changed.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await logsOf(staff.employeeId!)).toHaveLength(1);
  });
});
