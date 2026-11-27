// B4 (legend-wasr7.24): pairing code instead of a raw device token
// (docs/briefs/1272-b4-pair-code-brief.md). Backoffice gets an 8-character
// code; the tablet trades it once at POST /api/edc-bridge/pair.
//
// - right code once -> token; again -> EDC_PAIR_CODE_INVALID;
// - expired, cancelled by a new code, used: the same invalid answer;
// - 6th wrong code from one IP -> 429; a code is locked after 5 wrong, even
//   for the right code;
// - the token names the code's own device (outlet A code never gives outlet B
//   or another tenant's token);
// - POST /devices has no token; the code is never in audit or log;
// - two parallel redeems of one code: one token.
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createSimulatorBridgeCodec } from "../edge/edc/bridge-codec.ts";
import {
  getCloudEdcRuntime,
  hashEdcBridgeToken,
  startCloudEdcRuntime,
  stopCloudEdcRuntime,
} from "../edge/edc/cloud-runtime.ts";
import { logger } from "../lib/logger.ts";
import { edcBridgePairCodeDigest } from "../services/edc-bridge-pair.service.ts";
import { owner, seedTenantOutlets } from "./floor-test-helpers.ts";
import { originHeader } from "./helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 60_000 });

const DEVICES = "/api/edc-bridge/devices";
const PAIR = "/api/edc-bridge/pair";
const CODE = /^[2-9A-HJKMNP-Z]{8}$/;

let fx: HoldFixture;
let outletA2: string;

const staff = () => ({
  post: (path: string, body: Record<string, unknown>) =>
    fx.staff.client.post(path).set(fx.headers).set(originHeader).send(body),
});

/** A tablet: no cookie, no Origin. */
const pair = (body: Record<string, unknown>) =>
  request(fx.app).post(PAIR).set("Content-Type", "application/json").send(body);

async function createDevice(outletId: string, label = "Tablet") {
  const res = await staff().post(DEVICES, { outletId, label });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.data.device.id as string,
    code: res.body.data.pairCode.code as string,
    body: res.body,
    headers: res.headers,
  };
}

async function newCode(deviceId: string) {
  const res = await staff().post(`${DEVICES}/${deviceId}/pair-code`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.code as string;
}

async function tokenHashOf(deviceId: string) {
  const { rows } = await owner.query<{ token_hash: string }>(
    "SELECT token_hash FROM edc_bridge_devices WHERE id = $1",
    [ulidToUuid(deviceId)],
  );
  return rows[0]?.token_hash;
}

/** A wrong code with the same selector (first 4 characters) as `code`. */
const wrongFor = (code: string, i: number) =>
  `${code.slice(0, 4)}${["2222", "3333", "4444", "5555", "6666", "7777"].filter((tail) => tail !== code.slice(4))[i % 5]}`;

const expectInvalid = (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error.code).toBe("EDC_PAIR_CODE_INVALID");
  expect(res.headers["cache-control"]).toBe("no-store");
};

beforeAll(async () => {
  fx = await holdFixture("edc-bridge-pair");
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["payment.edc.manage"])],
  );
  outletA2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet B4 kedua', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3`,
    [outletA2, `B4${outletA2.slice(0, 6)}`.toUpperCase(), fx.tenant.outletId],
  );
  startCloudEdcRuntime({ codecs: [createSimulatorBridgeCodec("bca")] });
});

beforeEach(async () => {
  // Every request of this file comes from 127.0.0.1: one IP bucket.
  await owner.query("DELETE FROM edc_bridge_pair_ip_slots");
});

afterAll(async () => {
  await stopCloudEdcRuntime();
  resetHoldPorts();
  await owner.end();
});

describe("B4 pairing code", () => {
  it("b4-1 POST /devices answers a code, no token; the code pairs once and is never audited or logged", async () => {
    const spies = (
      ["trace", "debug", "info", "warn", "error", "fatal"] as const
    ).map((level) => vi.spyOn(logger, level));
    try {
      const device = await createDevice(fx.tenant.outletId, "Tablet kasir");
      expect(device.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(device.body.data).sort()).toEqual([
        "device",
        "pairCode",
      ]);
      expect(JSON.stringify(device.body)).not.toMatch(/edcb_/);
      expect(device.code).toMatch(CODE);
      const expiresIn =
        Date.parse(device.body.data.pairCode.expiresAt) - Date.now();
      expect(expiresIn).toBeGreaterThan(9 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);
      const before = await tokenHashOf(device.id);

      const paired = await pair({
        code: device.code.toLowerCase(),
        deviceFingerprint: "android-1",
      });
      expect(paired.status, JSON.stringify(paired.body)).toBe(200);
      expect(paired.headers["cache-control"]).toBe("no-store");
      const token = paired.body.data.token as string;
      expect(paired.body.data.deviceId).toBe(device.id);
      expect(token.startsWith(`edcb_${device.id}_`)).toBe(true);
      expect(await tokenHashOf(device.id)).toBe(hashEdcBridgeToken(token));
      expect(before).not.toBe(hashEdcBridgeToken(token));
      expect(await getCloudEdcRuntime()!.authenticate(token)).toEqual({
        id: device.id,
        tenantId: fx.tenant.tenantId,
        outletId: fx.tenant.outletId,
      });

      // Second time: invalid, token unchanged.
      expectInvalid(await pair({ code: device.code }));
      expect(await tokenHashOf(device.id)).toBe(hashEdcBridgeToken(token));

      // The request log's raw `req`/`res` objects (the parsed body hangs on
      // `req`) go through app.ts's serializer, which keeps only method, URL
      // and address; everything else logged is checked as is.
      const strip = (arg: unknown) =>
        arg && typeof arg === "object" && ("req" in arg || "res" in arg)
          ? { ...arg, req: undefined, res: undefined }
          : arg;
      for (const spy of spies) {
        const logged = inspect(
          spy.mock.calls.map((args) => args.map(strip)),
          { depth: 8 },
        );
        expect(logged).not.toContain(device.code);
        expect(logged).not.toContain(token);
      }
      const audit = await owner.query<{ row: string }>(
        `SELECT row_to_json(a)::text AS row FROM audit_logs a
          WHERE tenant_id = $1 AND event->>'objectType' = 'edc_bridge_device' AND event->>'objectId' = $2`,
        [fx.tenant.tenantId, device.id],
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(2);
      for (const { row } of audit.rows) {
        expect(row).not.toContain(device.code);
        expect(row).not.toContain(edcBridgePairCodeDigest(device.code));
        expect(row).not.toContain(token);
        expect(row).not.toContain(hashEdcBridgeToken(token));
      }
      const { rows } = await owner.query<{ row: string }>(
        `SELECT row_to_json(c)::text AS row FROM edc_bridge_pair_codes c WHERE device_id = $1`,
        [ulidToUuid(device.id)],
      );
      for (const { row } of rows) expect(row).not.toContain(device.code);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("b4-2 expired, cancelled by a new code, or of a revoked device: the same invalid answer", async () => {
    const device = await createDevice(fx.tenant.outletId);
    // A new code cancels the first one.
    const second = await newCode(device.id);
    expect(second).toMatch(CODE);
    const cancelled = await pair({ code: device.code });
    expectInvalid(cancelled);
    // Expired.
    await owner.query(
      "UPDATE edc_bridge_pair_codes SET expires_at = now() - interval '1 second' WHERE device_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
      [ulidToUuid(device.id)],
    );
    const expired = await pair({ code: second });
    expectInvalid(expired);
    const sansRequestId = (body: { error: Record<string, unknown> }) => ({
      ...body.error,
      requestId: undefined,
    });
    expect(sansRequestId(expired.body)).toEqual(sansRequestId(cancelled.body));
    // A fresh code of a revoked device.
    const third = await newCode(device.id);
    const revoke = await staff().post(`${DEVICES}/${device.id}/revoke`, {});
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expectInvalid(await pair({ code: third }));
    // No new code for a revoked device.
    const refused = await staff().post(`${DEVICES}/${device.id}/pair-code`, {});
    expect(refused.status).toBe(409);
  });

  it("b4-3 the 6th wrong code from one IP is 429, even with a right code", async () => {
    const device = await createDevice(fx.tenant.outletId);
    for (let i = 0; i < 5; i += 1)
      expectInvalid(await pair({ code: `ZZZZ${"2345"[i % 4]}XYZ` }));
    const blocked = await pair({ code: device.code });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Unused: still pairs once the window is gone.
    await owner.query("DELETE FROM edc_bridge_pair_ip_slots");
    expect((await pair({ code: device.code })).status).toBe(200);
  });

  it("b4-4 a code is locked after 5 wrong attempts, even for the right code", async () => {
    const device = await createDevice(fx.tenant.outletId);
    for (let i = 0; i < 5; i += 1)
      expectInvalid(await pair({ code: wrongFor(device.code, i) }));
    await owner.query("DELETE FROM edc_bridge_pair_ip_slots");
    expectInvalid(await pair({ code: device.code }));
    const { rows } = await owner.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM edc_bridge_pair_codes WHERE device_id = $1",
      [ulidToUuid(device.id)],
    );
    expect(rows).toEqual([{ failed_attempts: 5 }]);
    // A new code works.
    expect((await pair({ code: await newCode(device.id) })).status).toBe(200);
  });

  it("b4-5 the token names the code's own device: other outlet and other tenant untouched", async () => {
    const a1 = await createDevice(fx.tenant.outletId);
    const a2 = await createDevice(outletA2);
    const a2Before = await tokenHashOf(a2.id);
    // Tenant B device and code, written directly (no tenant B session).
    const tenantB = randomUUID();
    const [outletB] = (await seedTenantOutlets(tenantB, 1)) as [string];
    const deviceB = createUlid();
    await owner.query(
      `INSERT INTO edc_bridge_devices (id, tenant_id, outlet_id, label, token_hash, created_by)
       VALUES ($1, $2, $3, 'Tablet B', $4, 'test')`,
      [ulidToUuid(deviceB), tenantB, outletB, "0".repeat(64)],
    );
    const codeB = "B4PQRSTU";
    await owner.query(
      `INSERT INTO edc_bridge_pair_codes (tenant_id, outlet_id, device_id, code_selector, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes', 'test')`,
      [
        tenantB,
        outletB,
        ulidToUuid(deviceB),
        codeB.slice(0, 4),
        edcBridgePairCodeDigest(codeB),
      ],
    );

    const runtime = getCloudEdcRuntime()!;
    const tokenA1 = (await pair({ code: a1.code })).body.data.token as string;
    expect(await runtime.authenticate(tokenA1)).toEqual({
      id: a1.id,
      tenantId: fx.tenant.tenantId,
      outletId: fx.tenant.outletId,
    });
    expect(await tokenHashOf(a2.id)).toBe(a2Before);
    const pairedB = await pair({ code: codeB });
    expect(pairedB.status, JSON.stringify(pairedB.body)).toBe(200);
    expect(await runtime.authenticate(pairedB.body.data.token)).toEqual({
      id: deviceB,
      tenantId: tenantB,
      outletId: outletB,
    });
    expect(await tokenHashOf(a2.id)).toBe(a2Before);
  });

  it("b4-6 two parallel redeems of one code: exactly one token", async () => {
    const device = await createDevice(fx.tenant.outletId);
    const answers = await Promise.all([
      pair({ code: device.code }),
      pair({ code: device.code }),
      pair({ code: device.code }),
    ]);
    const ok = answers.filter((res) => res.status === 200);
    expect(ok).toHaveLength(1);
    for (const res of answers.filter((r) => r.status !== 200))
      expectInvalid(res);
    expect(await tokenHashOf(device.id)).toBe(
      hashEdcBridgeToken(ok[0]!.body.data.token),
    );
  });

  it("b4-7 strict body, no session needed", async () => {
    const bad = await pair({ code: "ABCD2345", extra: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).not.toBe("EDC_PAIR_CODE_INVALID");
    // 0, O, 1, I and L are not in the alphabet.
    expect((await pair({ code: "ABCD0O1I" })).status).toBe(422);
  });
});
