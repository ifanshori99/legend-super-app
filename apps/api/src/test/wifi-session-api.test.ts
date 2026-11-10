// Guest Wi-Fi sessions of a member over HTTP (PRD v1.7 §3 F25 "Wi-Fi Berbasis
// Belanja"; FAC-12, FAC-13; bead legend-kmd3 slice S3). Real Express app and
// PostgreSQL against the seeded Cafe Legend tenant. The policy has no peak
// window, so the allowance never depends on the clock of the test run. The
// edge agent is a fake installed through `installWifiEnforcement`.
//
// Time is moved by ageing `accrued_at` of a session row (as the migration
// owner): the next read accrues the elapsed minutes, exactly as it would after
// that much real time.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
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
import { createApp } from "../app";
import {
  installWifiEnforcement,
  type WifiEnforcement,
} from "../edge/wifi/port.ts";
import { HttpError } from "../lib/http-error.ts";
import { wifiDeviceHash } from "../services/wifi-session.service.ts";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers";
import {
  asTenant,
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  owner,
} from "./member-loyalty-helpers.ts";

let app: Express;
let other: IsolatedTenant;
const zoneA = randomUUID();
const zoneB = randomUUID();
const otherZone = randomUUID();

const MAC = "aa:bb:cc:dd:ee:ff";
const fingerprint = (label: string) => `fingerprint-${label}-0000`;

async function seedZoneWithPolicy(input: {
  tenantId: string;
  outletId: string;
  zoneId: string;
  maxDevices?: number;
}) {
  await asTenant(input.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [
        input.zoneId,
        input.tenantId,
        input.outletId,
        `Zona Wifi ${input.zoneId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes,
          spend_per_extra_hour_idr, extra_minutes, max_devices, peak_schedule,
          base_speed_kbps, full_speed_kbps, min_spend_per_hour_idr, tier_bonus_minutes)
       VALUES ($1, $2, $3, $4, 120, 60, 30000, 60, $5, '[]', 512, 20000, NULL, '{}')`,
      [
        randomUUID(),
        input.tenantId,
        input.outletId,
        input.zoneId,
        input.maxDevices ?? 2,
      ],
    );
  });
}

type Member = Awaited<ReturnType<typeof newMemberUser>>;
const newMember = () => newMemberUser(app, { profile: "active" });

const get = (member: Member, path: string) =>
  member.client.get(path).set(memberHeaders);
const post = (member: Member, path: string, body?: Record<string, unknown>) =>
  member.client
    .post(path)
    .set(memberHeaders)
    .set(originHeader)
    .send(body ?? {});
const start = (
  member: Member,
  label: string,
  extra: Record<string, unknown> = {},
  zoneId = zoneA,
) =>
  post(member, "/api/wifi/sessions", {
    zoneId,
    deviceFingerprint: fingerprint(label),
    ...extra,
  });

/** Moves a session `minutes` into the past: usage accrues on the next read. */
async function ageSession(sessionId: string, minutes: number) {
  await asTenant(seededTenantId, (client) =>
    client.query(
      `UPDATE wifi_sessions SET accrued_at = accrued_at - make_interval(mins => $2)
       WHERE id = $1`,
      [sessionId, minutes],
    ),
  );
}

/** A live grant row of a session, the way the agent leaves one (edge-local). */
async function seedGrant(sessionId: string, controllerDeviceId: string) {
  await owner.query(
    `INSERT INTO wifi_device_grants
       (tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
        speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds,
        status, renew_until, requested_at)
     SELECT tenant_id, outlet_id, id, device_hash, $2, 'full', 20000, 512, 3600,
            'pending', now() + interval '1 hour', now()
     FROM wifi_sessions WHERE id = $1`,
    [sessionId, controllerDeviceId],
  );
}

function fakeAgent() {
  return {
    applySession: vi.fn(async () => ({})),
    endSession: vi.fn(async () => []),
  };
}
let fake: ReturnType<typeof fakeAgent>;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  other = await createIsolatedTenant(`wifi${Date.now() % 100_000}`);
  await seedZoneWithPolicy({
    tenantId: seededTenantId,
    outletId: seededOutletA,
    zoneId: zoneA,
  });
  await seedZoneWithPolicy({
    tenantId: seededTenantId,
    outletId: seededOutletB,
    zoneId: zoneB,
  });
  await seedZoneWithPolicy({
    tenantId: other.tenantId,
    outletId: other.outletId,
    zoneId: otherZone,
  });
});

beforeEach(() => {
  fake = fakeAgent();
  // The service ignores what the agent answers; only the calls matter here.
  installWifiEnforcement(fake as unknown as WifiEnforcement);
});

afterEach(() => {
  installWifiEnforcement(null);
});

afterAll(async () => {
  await asTenant(seededTenantId, async (client) => {
    await client.query(
      `DELETE FROM wifi_device_grants
       WHERE wifi_session_id IN (SELECT id FROM wifi_sessions WHERE zone_id = ANY($1))`,
      [[zoneA, zoneB]],
    );
    await client.query("DELETE FROM wifi_sessions WHERE zone_id = ANY($1)", [
      [zoneA, zoneB],
    ]);
    await client.query("DELETE FROM wifi_policies WHERE zone_id = ANY($1)", [
      [zoneA, zoneB],
    ]);
    await client.query("DELETE FROM floor_zones WHERE id = ANY($1)", [
      [zoneA, zoneB],
    ]);
  });
  await asTenant(other.tenantId, (client) =>
    client.query("DELETE FROM wifi_policies WHERE zone_id = $1", [otherZone]),
  );
  await dropIsolatedTenant(other);
  await owner.end();
});

describe("legend-kmd3 guest Wi-Fi sessions", () => {
  it("answers 401 without a login on every guest route", async () => {
    const anonymous = () => agent(app);
    const sessionId = randomUUID();
    const responses = [
      await anonymous()
        .get(`/api/wifi/policy?zoneId=${zoneA}`)
        .set(memberHeaders),
      await anonymous().get("/api/wifi/sessions/current").set(memberHeaders),
      await anonymous()
        .post("/api/wifi/sessions")
        .set(memberHeaders)
        .set(originHeader)
        .send({ zoneId: zoneA, deviceFingerprint: fingerprint("anon") }),
      await anonymous()
        .post("/api/wifi/sessions/current/refresh")
        .set(memberHeaders)
        .set(originHeader)
        .send({}),
      await anonymous()
        .post(`/api/wifi/sessions/${sessionId}/end`)
        .set(memberHeaders)
        .set(originHeader),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    expect(fake.applySession).not.toHaveBeenCalled();
  });

  it("serves the zone policy and answers 404 for a zone of another tenant", async () => {
    const member = await newMember();
    const policy = await get(member, `/api/wifi/policy?zoneId=${zoneA}`);
    expect(policy.status).toBe(200);
    expect(policy.body.data).toMatchObject({
      zoneId: zoneA,
      tenantId: seededTenantId,
      freeMinutes: 120,
      maxDevices: 2,
    });
    const foreign = await get(member, `/api/wifi/policy?zoneId=${otherZone}`);
    expect(foreign.status).toBe(404);
    expect((await get(member, "/api/wifi/policy")).status).toBe(422);
  });

  it("grants the free two hours once per day, not once per session", async () => {
    const member = await newMember();
    const first = await start(member, "first");
    expect(first.status).toBe(200);
    expect(first.body.data.session).toMatchObject({
      quotaMinutes: 120,
      usedMinutes: 0,
      speedTier: "full",
      endedAt: null,
      customerProfileId: member.profileId,
    });
    expect(first.body.data.remainingMinutes).toBe(120);
    expect(first.body.data.session.deviceHash).toBe(
      wifiDeviceHash(seededTenantId, fingerprint("first")),
    );
    expect(typeof first.body.data.serverTime).toBe("string");

    // 70 minutes of use, then a second device: the day's use carries over.
    await ageSession(first.body.data.session.id, 70);
    const second = await start(member, "second");
    expect(second.status).toBe(200);
    expect(second.body.data.session.quotaMinutes).toBe(120);
    expect(second.body.data.session.usedMinutes).toBeGreaterThanOrEqual(70);
    expect(second.body.data.remainingMinutes).toBeLessThanOrEqual(50);

    // The first session now reads the same allowance, accrued to the minute.
    const current = await get(member, "/api/wifi/sessions/current");
    expect(current.status).toBe(200);
    expect(current.body.data.session.quotaMinutes).toBe(120);
  });

  it("refuses a third device with 409 and does not count a known device", async () => {
    const member = await newMember();
    expect((await start(member, "a")).status).toBe(200);
    expect((await start(member, "b")).status).toBe(200);

    const third = await start(member, "c");
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("WIFI_DEVICE_LIMIT");

    const again = await start(member, "a");
    expect(again.status).toBe(200);
    const sessions = await owner.query(
      `SELECT count(*)::int AS open FROM wifi_sessions
       WHERE customer_profile_id = $1 AND ended_at IS NULL`,
      [member.profileId],
    );
    expect(sessions.rows[0].open).toBe(2);
  });

  it("frees a place when a device session ends", async () => {
    const member = await newMember();
    const a = await start(member, "a");
    await start(member, "b");
    expect((await start(member, "c")).status).toBe(409);

    const ended = await post(
      member,
      `/api/wifi/sessions/${a.body.data.session.id}/end`,
    );
    expect(ended.status).toBe(200);
    expect(ended.body.data.endedAt).not.toBeNull();
    expect(fake.endSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        wifiSessionId: a.body.data.session.id,
        reason: "session_ended",
      }),
    );
    expect((await start(member, "c")).status).toBe(200);
  });

  it("refuses a client-supplied spend on refresh", async () => {
    const member = await newMember();
    await start(member, "a");
    const response = await post(member, "/api/wifi/sessions/current/refresh", {
      sameDaySpendIdr: 500_000,
    });
    expect(response.status).toBe(422);
    const current = await get(member, "/api/wifi/sessions/current");
    expect(current.body.data.session.quotaMinutes).toBe(120);
  });

  it("refreshes the quota from the server, and answers 404 without a session", async () => {
    const none = await newMember();
    expect(
      (await post(none, "/api/wifi/sessions/current/refresh")).status,
    ).toBe(404);
    const empty = await get(none, "/api/wifi/sessions/current");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    const member = await newMember();
    await start(member, "a");
    const refreshed = await post(member, "/api/wifi/sessions/current/refresh");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.session.quotaMinutes).toBe(120);
  });

  it("throttles to the base speed when the quota is spent and never cuts", async () => {
    const member = await newMember();
    const started = await start(member, "a", { controllerDeviceId: MAC });
    expect(fake.applySession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        controllerDeviceId: MAC,
        speedTier: "full",
        wifiSessionId: started.body.data.session.id,
      }),
    );

    await ageSession(started.body.data.session.id, 130);
    const spent = await get(member, "/api/wifi/sessions/current");
    expect(spent.status).toBe(200);
    expect(spent.body.data.session).toMatchObject({
      speedTier: "base",
      endedAt: null,
    });
    expect(spent.body.data.remainingMinutes).toBe(0);
    expect(spent.body.data.session.usedMinutes).toBeGreaterThanOrEqual(120);

    // A reload of the portal on the spent day gets base speed, never a cut.
    fake.applySession.mockClear();
    const reload = await start(member, "a", { controllerDeviceId: MAC });
    expect(reload.status).toBe(200);
    expect(reload.body.data.session.speedTier).toBe("base");
    expect(fake.applySession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ speedTier: "base", remainingSeconds: 0 }),
    );
    expect(fake.endSession).not.toHaveBeenCalled();
  });

  it("does not fail in the cloud where no agent is installed", async () => {
    installWifiEnforcement(null);
    const member = await newMember();
    const started = await start(member, "a", { controllerDeviceId: MAC });
    expect(started.status).toBe(200);
    const ended = await post(
      member,
      `/api/wifi/sessions/${started.body.data.session.id}/end`,
    );
    expect(ended.status).toBe(200);
  });

  it("never exposes the controller device id or the raw fingerprint", async () => {
    const member = await newMember();
    const started = await start(member, "secret", { controllerDeviceId: MAC });
    const text = JSON.stringify(started.body);
    expect(text).not.toContain(MAC);
    expect(text).not.toContain(fingerprint("secret"));
    const stored = await owner.query(
      "SELECT row_to_json(s)::text AS row FROM wifi_sessions s WHERE id = $1",
      [started.body.data.session.id],
    );
    expect(stored.rows[0].row).not.toContain(MAC);
    expect(stored.rows[0].row).not.toContain(fingerprint("secret"));
  });

  it("keeps the sessions of one account away from another member", async () => {
    const owned = await newMember();
    const stranger = await newMember();
    const started = await start(owned, "a");
    const sessionId = started.body.data.session.id as string;

    expect(
      (await get(stranger, "/api/wifi/sessions/current")).body.data,
    ).toBeNull();
    const end = await post(stranger, `/api/wifi/sessions/${sessionId}/end`);
    expect(end.status).toBe(404);
    expect(fake.endSession).not.toHaveBeenCalled();
    const still = await get(owned, "/api/wifi/sessions/current");
    expect(still.body.data.session.id).toBe(sessionId);
    expect(still.body.data.session.endedAt).toBeNull();
  });

  it("keeps one controller device per session: a new MAC ends the old grant first", async () => {
    const member = await newMember();
    const first = await start(member, "a", { controllerDeviceId: MAC });
    const sessionId = first.body.data.session.id as string;
    await seedGrant(sessionId, MAC);
    fake.applySession.mockClear();
    fake.endSession.mockClear();

    const otherMac = "11:22:33:44:55:66";
    const second = await start(member, "a", { controllerDeviceId: otherMac });
    expect(second.status).toBe(200);
    expect(second.body.data.session.id).toBe(sessionId);
    expect(fake.endSession).toHaveBeenCalledTimes(1);
    expect(fake.endSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        wifiSessionId: sessionId,
        reason: "device_moved",
      }),
    );
    expect(fake.applySession).toHaveBeenCalledTimes(1);
    expect(fake.applySession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ controllerDeviceId: otherMac }),
    );
    expect(fake.endSession.mock.invocationCallOrder[0]).toBeLessThan(
      fake.applySession.mock.invocationCallOrder[0] as number,
    );

    // The same MAC again is not a move.
    fake.endSession.mockClear();
    await owner.query(
      "UPDATE wifi_device_grants SET controller_device_id = $2 WHERE wifi_session_id = $1",
      [sessionId, otherMac],
    );
    expect(
      (await start(member, "a", { controllerDeviceId: otherMac })).status,
    ).toBe(200);
    expect(fake.endSession).not.toHaveBeenCalled();
  });

  it("passes the end of the business day to the edge on start", async () => {
    const member = await newMember();
    const before = Date.now();
    const started = await start(member, "a", { controllerDeviceId: MAC });
    expect(started.status).toBe(200);
    const call = fake.applySession.mock.calls[0] as unknown as [
      unknown,
      { sessionEndsAt: string },
    ];
    const endsAt = Date.parse(call[1].sessionEndsAt);
    expect(endsAt).toBeGreaterThan(before);
    expect(endsAt).toBeLessThan(before + 24 * 60 * 60_000);
  });

  it("forwards edge refusals on start but not a missing agent", async () => {
    const member = await newMember();
    fake.applySession.mockRejectedValueOnce(
      new HttpError(409, "WIFI_DEVICE_BOUND_ELSEWHERE", "bound"),
    );
    const bound = await start(member, "a", { controllerDeviceId: MAC });
    expect(bound.status).toBe(409);
    expect(bound.body.error.code).toBe("WIFI_DEVICE_BOUND_ELSEWHERE");

    fake.applySession.mockRejectedValueOnce(
      new HttpError(409, "WIFI_GRANT_IN_FLIGHT", "busy"),
    );
    const busy = await start(member, "a", { controllerDeviceId: MAC });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("WIFI_GRANT_IN_FLIGHT");

    fake.applySession.mockRejectedValueOnce(
      new HttpError(503, "WIFI_AGENT_NOT_READY", "no agent"),
    );
    const notReady = await start(member, "a", { controllerDeviceId: MAC });
    expect(notReady.status).toBe(200);
  });

  it("shares the account advisory lock with the quota consumer", async () => {
    const member = await newMember();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `wifi:${seededTenantId}:${member.profileId}`,
      ]);
      let done = false;
      const pending = start(member, "a").then((response) => {
        done = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(done).toBe(false);
      await client.query("COMMIT");
      expect((await pending).status).toBe(200);
    } finally {
      client.release();
    }
  });

  it("hides a session from another tenant and from another outlet (RLS)", async () => {
    const member = await newMember();
    const inA = await start(member, "a");
    const inB = await start(member, "b", {}, zoneB);
    expect(inA.status).toBe(200);
    expect(inB.status).toBe(200);
    expect(inB.body.data.session.outletId).toBe(seededOutletB);

    const visible = async (tenantId: string, outletIds: string) => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_app");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
          [tenantId, outletIds],
        );
        const result = await client.query(
          "SELECT id FROM wifi_sessions WHERE customer_profile_id = $1",
          [member.profileId],
        );
        await client.query("COMMIT");
        return result.rows.map((row: { id: string }) => row.id);
      } finally {
        client.release();
      }
    };
    expect(await visible(other.tenantId, "*")).toEqual([]);
    expect(
      await visible(seededTenantId, JSON.stringify([seededOutletA])),
    ).toEqual([inA.body.data.session.id]);
    expect(await visible(seededTenantId, "*")).toHaveLength(2);
  });
});
