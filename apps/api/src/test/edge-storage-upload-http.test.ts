// T8 (storage part) of docs/design/hris-edge-replication.md sections 5 and 9:
// over real HTTP, an edge node serves POST /api/storage/uploads for purpose
// `selfie` only; every other purpose answers 503 on the edge; any other
// /api/storage method or path is cloud only (404 CLOUD_ONLY_ROUTE); no
// session is 401; neither the response nor the process logs ever carry the
// selfie bytes or a PIN.
//
// Session helper (assumption): no PIN login route is mounted on the edge, so
// there is no HTTP way to obtain a "staff PIN" session. The most faithful
// stand-in is the edge sign-in path (POST /api/auth/sign-in/email, which the
// edge serves) for a user that has an active employee row and a role with
// self.attendance.clock scoped to the outlet. The user itself is created on a
// cloud app instance because sign-up is cloud only. The device token is not
// involved: the design (section 5) gives the upload route no device check.
//
// Other assumptions:
// - The edge app is createApp({ edgeMode: true }) with EDGE_MODE=true in the
//   process while requests run; its storage runtime is the app default.
// - An outlet whose edge_people_sync_state row has a 3072-bit RSA public key
//   accepts a selfie (201) and keeps only a sealed .lss file under
//   EDGE_SELFIE_DIR. An outlet without such a row answers 503
//   SELFIE_SEAL_KEY_MISSING.
// - The error code is read from body.error.code or body.code (both shapes are
//   used by the API).
// - "Log" means anything written to stdout/stderr/console during the request.
//   A pino logger writing straight to a file descriptor would bypass this
//   spy; the check is best effort for logs and exact for the response.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "edge-storage-http-"));
  process.env.EDGE_SELFIE_DIR = dir;
  // config/env.ts is parsed on first import: the edge storage router is chosen
  // from env.EDGE_MODE when createApp runs, so it must be set here.
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  // Well-formed, never presented anywhere (the test runs no link).
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000001.5d1e7c00-0000-4000-8000-000000000002.5d1e7c00-0000-4000-8000-000000000003." +
    "A".repeat(43);
  return dir;
});

import {
  cafeLegendPlatformFixtures,
  DEVICE_TOKEN_HEADER,
} from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const PASSWORD = "Test-password-123!"; // the helpers.ts sign-up password
const PIN = "482915";
const EXIF_MARKER = "selfie-marker-5d1e7c";
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const cloud = createApp({ edgeMode: false });
const edge = createApp({ edgeMode: true, storageRuntime: null });
const SCANNER_DIAGNOSTIC = "scanner-internal-diagnostic-sentinel";
const scanningEdge = (error: Error) =>
  createApp({
    edgeMode: true,
    storageRuntime: {
      storage: new FakeObjectStorage(),
      scanner: {
        async scan() {
          throw error;
        },
      },
      fileSigner: async () => null,
      hrisDocumentSigner: async () => null,
    },
  });
const scannerCases = [
  {
    label: "content rejection",
    app: scanningEdge(new HttpError(422, "INVALID_IMAGE", SCANNER_DIAGNOSTIC)),
    status: 422,
    code: "UPLOAD_REJECTED",
  },
  {
    label: "scanner outage",
    app: scanningEdge(new Error(SCANNER_DIAGNOSTIC)),
    status: 503,
    code: "SCANNER_UNAVAILABLE",
  },
];

const createdUsers: string[] = [];
const createdDevices: string[] = [];
const createdProofs: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let sealedOutlet: string; // has a seal public key
let keylessOutlet: string; // no edge_people_sync_state row

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

async function seedOutlet() {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet unggah edge', 'Jl. Unggah', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `UH-${id.slice(0, 8)}`.toUpperCase(),
      ],
    );
  });
  return id;
}

/**
 * A staff member of both outlets who may clock, signed in on the EDGE app.
 * The user is created on the cloud app (sign-up is cloud only).
 */
async function edgeStaff(name: string, app = edge) {
  const signUpClient = agent(cloud);
  const email = await signUp(signUpClient, name);
  const session = await signUpClient.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);

  const roleId = randomUUID();
  createdRoles.push(roleId);
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Edge unggah ${roleId.slice(0, 8)}`,
        JSON.stringify(["self.profile.view", "self.attendance.clock"]),
        JSON.stringify(["outlet"]),
      ],
    );
    for (const outletId of [sealedOutlet, keylessOutlet])
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, outletId],
      );
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Unggah Edge', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `UH-${employeeId.slice(0, 8).toUpperCase()}`,
        sealedOutlet,
      ],
    );
  });

  const client = agent(app);
  const signIn = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
  return { client, userId };
}

let image: Buffer;

/** A registered pos device at `outletId` and a signed token for it. */
async function seedDevice(outletId: string) {
  const deviceId = randomUUID();
  createdDevices.push(deviceId);
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenant((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Layar absen', $4)`,
      [deviceId, tenant.id, outletId, new Date(issuedAt * 1000)],
    ),
  );
  return {
    deviceId,
    token: signDeviceToken({
      version: 1,
      tenantId: tenant.id,
      brandId: null,
      deviceId,
      issuedAt,
    }),
  };
}

/** A PIN proof row for (device, user), as /api/staff-pins/verify would issue. */
async function seedProof(
  device: { deviceId: string },
  outletId: string,
  userId: string,
  state: "live" | "consumed" | "expired" = "live",
) {
  const token = `pp_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  createdProofs.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO staff_pin_proofs
         (id, tenant_id, outlet_id, device_id, user_id, purpose, token_hash, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, 'attendance_clock', $6,
               now() + ($7 * interval '1 second'), $8)`,
      [
        id,
        tenant.id,
        outletId,
        device.deviceId,
        userId,
        createHash("sha256").update(token).digest(),
        state === "expired" ? -60 : 120,
        state === "consumed" ? new Date() : null,
      ],
    ),
  );
  return { id, token };
}

/** Sessionless upload under a PIN proof (legend-u7g9w). */
const proofUpload = (
  headers: { deviceToken?: string; proof?: string },
  fields: { purpose: string; outletId?: string } = {
    purpose: "selfie",
    outletId: sealedOutlet,
  },
  client: ReturnType<typeof agent> = agent(edge),
) => {
  let req = client
    .post("/api/storage/uploads")
    .field("purpose", fields.purpose);
  if (headers.deviceToken)
    req = req.set(DEVICE_TOKEN_HEADER, headers.deviceToken);
  if (headers.proof) req = req.set("X-Pin-Proof", headers.proof);
  if (fields.outletId) req = req.field("outletId", fields.outletId);
  return req.attach("file", image, {
    filename: "selfie.jpg",
    contentType: "image/jpeg",
  });
};

const storedObject = async (id: string) =>
  (
    await owner.query<{
      owner_user_id: string | null;
      pin_proof_id: string | null;
      outlet_id: string;
    }>(
      "SELECT owner_user_id, pin_proof_id, outlet_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenant.id, id],
    )
  ).rows[0];

const upload = (
  client: ReturnType<typeof agent>,
  fields: { purpose: string; outletId?: string },
) => {
  let req = client
    .post("/api/storage/uploads")
    .set(originHeader)
    // A PIN-like value on the request, to prove nothing echoes it back.
    .set("X-Staff-Pin", PIN)
    .field("purpose", fields.purpose);
  if (fields.outletId) req = req.field("outletId", fields.outletId);
  return req.attach("file", image, {
    filename: "selfie.jpg",
    contentType: "image/jpeg",
  });
};

const codeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

/** Every file below `dir`, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesIn(path.join(dir, entry.name))
      : [path.join(dir, entry.name)],
  );
}

// Captures everything written to the process streams while a test runs.
let captured: string[] = [];
beforeEach(() => {
  captured = [];
  const sink = (chunk: unknown) => {
    captured.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Buffer).toString("latin1"),
    );
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(sink as never);
  vi.spyOn(process.stderr, "write").mockImplementation(sink as never);
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Nothing the user sent that must stay secret appears in `text`. */
function expectNoSecrets(text: string, label: string) {
  expect(text.includes(PIN), `${label} contains the PIN`).toBe(false);
  expect(text.includes(EXIF_MARKER), `${label} contains image metadata`).toBe(
    false,
  );
  expect(
    text.includes(image.toString("base64").slice(0, 80)),
    `${label} contains the image as base64`,
  ).toBe(false);
  expect(
    text.includes(image.subarray(0, 64).toString("latin1")),
    `${label} contains raw image bytes`,
  ).toBe(false);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  image = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "teal" },
  })
    .withExif({ IFD0: { ImageDescription: EXIF_MARKER } })
    .jpeg()
    .toBuffer();
  sealedOutlet = await seedOutlet();
  keylessOutlet = await seedOutlet();
  await owner.query(
    `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key)
     VALUES ($1, $2, 'http-test-kid-1', $3)`,
    [tenant.id, sealedOutlet, publicKey],
  );
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM edge_selfie_uploads WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    // core_storage_objects.pin_proof_id is ON DELETE SET NULL.
    await client.query(
      "DELETE FROM staff_pin_proofs WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdProofs],
    );
    await client.query(
      "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdDevices],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets and storage objects stay: audit_logs is append-only and
    // references them (disposable DB).
  });
  await owner.end();
  rmSync(edgeDir, { recursive: true, force: true });
});

describe("T8 POST /api/storage/uploads on the edge (HTTP)", () => {
  it.each(scannerCases)(
    "normalizes $label for session uploads and stores nothing",
    async ({ app, status, code }) => {
      const staff = await edgeStaff("Staf Pemindai Sesi", app);
      const before = filesIn(edgeDir).length;
      const rowsBefore = await owner.query(
        "SELECT id FROM core_storage_objects WHERE tenant_id = $1 AND uploaded_by = $2",
        [tenant.id, staff.userId],
      );
      const response = await upload(staff.client, {
        purpose: "selfie",
        outletId: sealedOutlet,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      expect(codeOf(response.body)).toBe(code);
      expect(JSON.stringify(response.body)).not.toContain(SCANNER_DIAGNOSTIC);
      expect(captured.join("\n")).not.toContain(SCANNER_DIAGNOSTIC);
      expect(filesIn(edgeDir)).toHaveLength(before);
      const rowsAfter = await owner.query(
        "SELECT id FROM core_storage_objects WHERE tenant_id = $1 AND uploaded_by = $2",
        [tenant.id, staff.userId],
      );
      expect(rowsAfter.rows).toEqual(rowsBefore.rows);
    },
  );

  it("accepts a selfie for an outlet with a seal key and keeps only a sealed file", async () => {
    const staff = await edgeStaff("Staf Unggah Selfie");
    const response = await upload(staff.client, {
      purpose: "selfie",
      outletId: sealedOutlet,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      purpose: "selfie",
      contentType: "image/webp",
    });
    expect(typeof response.body.data.id).toBe("string");

    const files = filesIn(edgeDir).filter((file) =>
      file.includes(response.body.data.id as string),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".lss")).toBe(true);

    expectNoSecrets(JSON.stringify(response.body), "response");
    expectNoSecrets(JSON.stringify(response.headers), "response headers");
    expectNoSecrets(captured.join("\n"), "log output");
  });

  it("answers 503 SELFIE_SEAL_KEY_MISSING for an outlet without a seal key and stores nothing", async () => {
    const staff = await edgeStaff("Staf Unggah Tanpa Kunci");
    const before = filesIn(edgeDir).length;
    const response = await upload(staff.client, {
      purpose: "selfie",
      outletId: keylessOutlet,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(codeOf(response.body)).toBe("SELFIE_SEAL_KEY_MISSING");
    expect(filesIn(edgeDir)).toHaveLength(before);

    expectNoSecrets(JSON.stringify(response.body), "response");
    expectNoSecrets(captured.join("\n"), "log output");
  });

  it("refuses every purpose other than selfie (403 when the staff role lacks it, else 503) and stores nothing", async () => {
    const staff = await edgeStaff("Staf Unggah Purpose Lain");
    const before = filesIn(edgeDir).length;
    for (const purpose of ["receipt", "document", "menu_photo"]) {
      const response = await upload(staff.client, {
        purpose,
        outletId: sealedOutlet,
      });
      // The permission check runs first: a clock-only staff role has no
      // right to these purposes (403); a role that has it meets the edge's
      // own 503. Either way nothing is stored.
      expect(
        [403, 503],
        `${purpose}: ${JSON.stringify(response.body)}`,
      ).toContain(response.status);
      expectNoSecrets(JSON.stringify(response.body), `${purpose} response`);
    }
    // A brand logo has no outlet.
    const logo = await upload(staff.client, { purpose: "brand_logo" });
    expect([403, 503], JSON.stringify(logo.body)).toContain(logo.status);
    expect(filesIn(edgeDir)).toHaveLength(before);
    expectNoSecrets(captured.join("\n"), "log output");
  });

  it("answers 401 without a session, for a selfie and for any other purpose", async () => {
    for (const purpose of ["selfie", "receipt"]) {
      const response = await upload(agent(edge), {
        purpose,
        outletId: sealedOutlet,
      });
      expect(
        response.status,
        `${purpose}: ${JSON.stringify(response.body)}`,
      ).toBe(401);
    }
    expectNoSecrets(captured.join("\n"), "log output");
  });

  it("keeps every other /api/storage method and path cloud only (404 CLOUD_ONLY_ROUTE)", async () => {
    const staff = await edgeStaff("Staf Unggah Rute Lain");
    const objectId = randomUUID();
    for (const [method, target] of [
      ["get", "/api/storage/uploads"],
      ["put", "/api/storage/uploads"],
      ["delete", "/api/storage/uploads"],
      ["post", "/api/storage/uploads/x"],
      ["post", "/api/storage"],
      ["get", `/api/storage/objects/${objectId}`],
      ["post", `/api/storage/objects/${objectId}/signed-url`],
    ] as const) {
      const response = await staff.client[method](target).set(originHeader);
      expect(response.status, `${method} ${target}`).toBe(404);
      expect(codeOf(response.body), `${method} ${target}`).toBe(
        "CLOUD_ONLY_ROUTE",
      );
    }
  });

  it("the cloud does not refuse the storage upload route as cloud only", async () => {
    const response = await agent(cloud)
      .post("/api/storage/uploads")
      .set(originHeader)
      .field("purpose", "selfie");
    // Reached the route (auth first), never refused by the edge split.
    expect(codeOf(response.body)).not.toBe("CLOUD_ONLY_ROUTE");
  });
});

describe("legend-u7g9w POST /api/storage/uploads with X-Pin-Proof (HTTP)", () => {
  it.each(scannerCases)(
    "normalizes $label for PIN-proof uploads and stores nothing",
    async ({ app, status, code }) => {
      const staff = await edgeStaff("Staf Pemindai Bukti");
      const device = await seedDevice(sealedOutlet);
      const proof = await seedProof(device, sealedOutlet, staff.userId);
      const before = filesIn(edgeDir).length;
      const response = await proofUpload(
        { deviceToken: device.token, proof: proof.token },
        undefined,
        agent(app),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      expect(codeOf(response.body)).toBe(code);
      expect(JSON.stringify(response.body)).not.toContain(SCANNER_DIAGNOSTIC);
      expect(captured.join("\n")).not.toContain(SCANNER_DIAGNOSTIC);
      expect(filesIn(edgeDir)).toHaveLength(before);
      const objects = await owner.query(
        "SELECT id FROM core_storage_objects WHERE tenant_id = $1 AND pin_proof_id = $2",
        [tenant.id, proof.id],
      );
      expect(objects.rows).toHaveLength(0);
      const proofRow = await owner.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM staff_pin_proofs WHERE id = $1",
        [proof.id],
      );
      expect(proofRow.rows[0]?.consumed_at).toBeNull();
    },
  );

  it("stores the selfie with no session; owner, outlet and pin_proof_id come from the proof and the device", async () => {
    const staff = await edgeStaff("Staf Unggah Bukti");
    const device = await seedDevice(sealedOutlet);
    const proof = await seedProof(device, sealedOutlet, staff.userId);
    const response = await proofUpload(
      { deviceToken: device.token, proof: proof.token },
      // The client's outlet is ignored: the device's outlet wins.
      { purpose: "selfie", outletId: keylessOutlet },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await storedObject(response.body.data.id as string);
    expect(row).toEqual({
      owner_user_id: staff.userId,
      pin_proof_id: proof.id,
      outlet_id: sealedOutlet,
    });
    const files = filesIn(edgeDir).filter((file) =>
      file.includes(response.body.data.id as string),
    );
    expect(files).toHaveLength(1);
    expectNoSecrets(JSON.stringify(response.body), "response");
    expectNoSecrets(captured.join("\n"), "log output");
  });

  it("owner is the proof's staff even when another user's session cookie is sent", async () => {
    const cashier = await edgeStaff("Kasir Sesi Unggah");
    const staff = await edgeStaff("Staf Bukti Unggah");
    const device = await seedDevice(sealedOutlet);
    const proof = await seedProof(device, sealedOutlet, staff.userId);
    const response = await proofUpload(
      { deviceToken: device.token, proof: proof.token },
      undefined,
      cashier.client,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const row = await storedObject(response.body.data.id as string);
    expect(row?.owner_user_id).toBe(staff.userId);
    expect(row?.pin_proof_id).toBe(proof.id);
  });

  it("does not consume the proof: the same proof uploads again", async () => {
    const staff = await edgeStaff("Staf Unggah Dua Kali");
    const device = await seedDevice(sealedOutlet);
    const proof = await seedProof(device, sealedOutlet, staff.userId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await proofUpload({
        deviceToken: device.token,
        proof: proof.token,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const { rows } = await owner.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM staff_pin_proofs WHERE id = $1",
      [proof.id],
    );
    expect(rows[0]?.consumed_at).toBeNull();
  });

  it("answers 401 PIN_PROOF_INVALID for a used, expired, superseded, foreign-device or unknown proof, and stores nothing", async () => {
    const staff = await edgeStaff("Staf Bukti Gagal");
    const device = await seedDevice(sealedOutlet);
    const otherDevice = await seedDevice(sealedOutlet);
    const used = await seedProof(
      device,
      sealedOutlet,
      staff.userId,
      "consumed",
    );
    const expired = await seedProof(
      device,
      sealedOutlet,
      staff.userId,
      "expired",
    );
    const superseded = await seedProof(device, sealedOutlet, staff.userId);
    await owner.query(
      "UPDATE staff_pin_proofs SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [superseded.id],
    );
    const foreign = await seedProof(otherDevice, sealedOutlet, staff.userId);
    const before = filesIn(edgeDir).length;
    const cases: Array<[string, { deviceToken?: string; proof?: string }]> = [
      ["used", { deviceToken: device.token, proof: used.token }],
      ["expired", { deviceToken: device.token, proof: expired.token }],
      ["superseded", { deviceToken: device.token, proof: superseded.token }],
      ["other device", { deviceToken: device.token, proof: foreign.token }],
      ["unknown", { deviceToken: device.token, proof: "pp_unknown" }],
      ["no device token", { proof: foreign.token }],
      ["bad device token", { deviceToken: "x.y", proof: foreign.token }],
    ];
    // Without a usable device token the tenant cannot be told, so the request
    // fails closed with 404 TENANT_NOT_FOUND before any proof is looked at.
    const noTenant = new Set(["no device token", "bad device token"]);
    for (const [label, headers] of cases) {
      const response = await proofUpload(headers);
      const missing = noTenant.has(label);
      expect(
        response.status,
        `${label}: ${JSON.stringify(response.body)}`,
      ).toBe(missing ? 404 : 401);
      expect(codeOf(response.body), label).toBe(
        missing ? "TENANT_NOT_FOUND" : "PIN_PROOF_INVALID",
      );
    }
    expect(filesIn(edgeDir)).toHaveLength(before);
  });

  it("serves only the selfie purpose on the proof path (503), storing nothing", async () => {
    const staff = await edgeStaff("Staf Bukti Purpose");
    const device = await seedDevice(sealedOutlet);
    const proof = await seedProof(device, sealedOutlet, staff.userId);
    const before = filesIn(edgeDir).length;
    for (const purpose of ["receipt", "document", "menu_photo"]) {
      const response = await proofUpload(
        { deviceToken: device.token, proof: proof.token },
        { purpose, outletId: sealedOutlet },
      );
      expect(
        response.status,
        `${purpose}: ${JSON.stringify(response.body)}`,
      ).toBe(503);
    }
    expect(filesIn(edgeDir)).toHaveLength(before);
  });

  it("without the proof header a sessionless request is still 401 (session path unchanged)", async () => {
    const device = await seedDevice(sealedOutlet);
    const response = await proofUpload({ deviceToken: device.token });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
  });
});
