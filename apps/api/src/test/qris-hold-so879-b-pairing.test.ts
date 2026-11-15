// legend-eqeu7 (pairing part, docs/qa/second-opinion-qris-hold.md P2): the
// pairing guess limiter (5 attempts per terminal and 20 per outlet in 5
// minutes) must hold under PARALLEL requests.
//
// Old behavior: each request inserted its attempt and counted in its own
// READ COMMITTED transaction without a shared lock, so parallel requests did
// not see each other's uncommitted attempts and all slipped under the limit
// (staff on an active terminal could try more six-digit guesses than allowed).
//
// Assumptions (as pos-customer-display.test.ts): the sequential contract is
// "attempts 1-5 are judged, the 6th is 429". A request that is judged is any
// response other than 429 (a wrong code is a 4xx, never 429). Here every
// guess is wrong (except the final probe), so no pairing may exist at the end.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { owner, seedTenantOutlets } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const TERMINAL_MAX = 5;
const OUTLET_MAX = 20;

type Device = { id: string; outletId: string; token: string };

let fx: HoldFixture;
let outletIds: string[];
const known = new Map<string, { tenantId: string; outletId: string }>();

beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-pairing");
  outletIds = await seedTenantOutlets(fx.tenant.tenantId, 2);
  setDeviceOutletResolver(async (input) => {
    const device = known.get(input.deviceId);
    return device && device.tenantId === input.tenantId
      ? device.outletId
      : null;
  });
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function newDevice(
  outletId: string,
  type: "pos" | "display",
): Promise<Device> {
  const id = randomUUID();
  await asCashierTenant(fx.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
      [id, fx.tenant.tenantId, outletId, type, `${type} so879 ${id.slice(0, 8)}`],
    ),
  );
  known.set(id, { tenantId: fx.tenant.tenantId, outletId });
  return {
    id,
    outletId,
    token: signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: fx.tenant.tenantId,
      brandId: null,
      deviceId: id,
    }),
  };
}

const path = (outletId: string, suffix: string) =>
  `/api/outlets/${outletId}/pos/customer-display${suffix}`;

async function codeFor(display: Device): Promise<string> {
  const res = await agent(fx.app)
    .post(path(display.outletId, "/pairing-codes"))
    .set("Host", fx.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, display.token)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.code as string;
}

const pair = (terminal: Device, code: string) =>
  fx.staff.client
    .post(path(terminal.outletId, "/pair"))
    .set("Host", fx.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, terminal.token)
    .send({ code, idempotencyKey: randomUUID() });

/** A six-digit guess that is never `right`. */
const wrongGuess = (n: number, right: string) =>
  String(300000 + n) === right ? "999997" : String(300000 + n);

async function pairingsOf(outletId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM customer_display_pairings WHERE tenant_id=$1 AND outlet_id=$2`,
    [fx.tenant.tenantId, outletId],
  );
  return rows.length;
}

describe("legend-eqeu7 pairing limiter under parallel requests", () => {
  it("eqeu7-pair-1 12 parallel wrong codes from one terminal: at most 5 are judged, the rest are 429, and the right code is then 429", async () => {
    const outletId = outletIds[0]!;
    const display = await newDevice(outletId, "display");
    const terminal = await newDevice(outletId, "pos");
    const code = await codeFor(display);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => pair(terminal, wrongGuess(i, code))),
    );

    const judged = responses.filter((r) => r.status !== 429);
    expect(
      judged.length,
      `judged ${judged.length} guesses, limit is ${TERMINAL_MAX}`,
    ).toBeLessThanOrEqual(TERMINAL_MAX);
    for (const r of judged) {
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    // Nothing paired, and the right code is blocked too (limit reached).
    const blocked = await pair(terminal, code);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(await pairingsOf(outletId)).toBe(0);
  });

  it("eqeu7-pair-2 28 parallel wrong codes spread over 7 terminals of one outlet: at most 20 are judged, then the right code from a fresh terminal is 429", async () => {
    const outletId = outletIds[1]!;
    const display = await newDevice(outletId, "display");
    const code = await codeFor(display);
    const terminals = await Promise.all(
      Array.from({ length: 7 }, () => newDevice(outletId, "pos")),
    );

    const responses = await Promise.all(
      terminals.flatMap((terminal, t) =>
        Array.from({ length: 4 }, (_, i) =>
          pair(terminal, wrongGuess(t * 4 + i, code)),
        ),
      ),
    );

    const judged = responses.filter((r) => r.status !== 429);
    expect(
      judged.length,
      `judged ${judged.length} guesses, limit is ${OUTLET_MAX}`,
    ).toBeLessThanOrEqual(OUTLET_MAX);
    const fresh = await newDevice(outletId, "pos");
    const blocked = await pair(fresh, code);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(await pairingsOf(outletId)).toBe(0);
  });
});
