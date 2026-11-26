// Brief 1270 card W1b: WFC settings proposals, approval bound to the numbers,
// and the price floor on save and switch-on. Against PostgreSQL with the
// restricted app role (RLS forced). AI never applies: a version is written only
// after another person with `wfc.policy.manage` approved the exact numbers.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { establishTenantContext } from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { ProposeWfcSettingsInput } from "@starter/shared/wfc";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import {
  createWfcSeat,
  putWfcHourlyQuotas,
  setWfcProduct,
} from "../services/wfc-seat.service.ts";
import {
  applyApprovedWfcSettings,
  applyWfcSettings,
  handleWfcSettingsApprovalResolved,
  listWfcSettings,
  proposeWfcSettings,
  setWfcProductActive,
} from "../services/wfc-settings.service.ts";
import { wfcBusinessDate } from "../services/wfc-settings.ts";
import { seedFacility } from "./facility-entitlement-helpers.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedProfile,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

type Failure = { status?: number; code?: string };

async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    const e = error as Failure;
    return { status: e.status, code: e.code };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

const PROPOSER = [
  "wfc.policy.manage",
  "facility.config.manage",
  "facility.booth.operate",
];
/** The matrix's approver role: may decide, nothing more. */
const APPROVER = ["approval.request.decide", "approval.inbox.view"];
const POLICY = ["wfc.policy.manage", "facility.config.manage"];

async function seedRole(tenantId: string, permissions: string[]) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  return roleId;
}

async function seedUser(tenantId: string, roleId: string): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC settings test", `${userId}@example.com`],
  );
  await assign(tenantId, userId, roleId);
  return userId;
}

async function assign(tenantId: string, userId: string, roleId: string) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

async function setup() {
  const world = await createWorld();
  const approverRole = await seedRole(world.tenantId, APPROVER);
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'price_change', NULL, $2, 1)`,
    [world.tenantId, approverRole],
  );
  const proposerRole = await seedRole(world.tenantId, PROPOSER);
  const proposer = await seedUser(world.tenantId, proposerRole);
  const approver = await seedUser(world.tenantId, approverRole);
  await assign(
    world.tenantId,
    approver,
    await seedRole(world.tenantId, POLICY),
  );
  // Can decide in the inbox but holds no wfc.policy.manage.
  const decideOnly = await seedUser(world.tenantId, approverRole);
  const zoneId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours, is_wfc)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]', true)`,
      [zoneId, world.tenantId, world.outletA, `Zona ${short()}`],
    ),
  );
  const facilityId = await seedFacility(world, world.outletA, "coworking");
  const today = await withTenant(db, world.context, (tx) =>
    wfcBusinessDate(tx, world.context, world.outletA, new Date()),
  );
  return { world, proposer, approver, decideOnly, zoneId, facilityId, today };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Brief example: peak Rp39.000 / h, off-peak Rp20.000 / h. */
const numbers = (s: Setup, overrides: Partial<ProposeWfcSettingsInput> = {}) =>
  ({
    outletId: s.world.outletA,
    effectiveFrom: s.today,
    totalSeats: 60,
    wfcSeats: 20,
    openHoursPerMonth: 420,
    fixedCostIdr: 100_000_000,
    targetRevenueIdr: 200_000_000,
    targetProfitIdr: 50_000_000,
    targetOccupancyBp: 5000,
    spendPerPersonIdr: 60_000,
    cogsBp: 3500,
    avgStayMinutes: 60,
    noShowMinutes: 30,
    reason: "Angka bulan ini",
    ...overrides,
  }) as ProposeWfcSettingsInput;

const tenantSession = (world: World) =>
  establishTenantContext({
    tenantId: world.tenantId,
    brandId: null,
    source: "session",
  });

const decide = (
  s: Setup,
  userId: string,
  chainId: string,
  decision: "approved" | "rejected" = "approved",
) =>
  decideApprovalRequest(
    tenantSession(s.world),
    userId,
    chainId,
    { decision, reason: "Sudah dicek" },
    { mfaVerified: true, idempotencyKey: null },
  );

const apply = (s: Setup, chainId: string, context?: ScopedTenantContext) =>
  withTenant(db, context ?? s.world.context, (tx) =>
    applyApprovedWfcSettings(
      tx,
      context ?? s.world.context,
      chainId,
      new Date(),
    ),
  );

async function approvedVersion(
  s: Setup,
  overrides: Partial<ProposeWfcSettingsInput> = {},
) {
  const proposal = await proposeWfcSettings(
    s.world.context,
    s.proposer,
    numbers(s, overrides),
  );
  await decide(s, s.approver, proposal.chainId);
  const version = await apply(s, proposal.chainId);
  expect(version?.id).toBe(proposal.settingsId);
  return proposal;
}

async function seedProduct(s: Setup) {
  const id = randomUUID();
  await asTenant(s.world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
       VALUES ($1, $2, $3, $4, $5, 'single', 70000, 1)`,
      [id, s.world.tenantId, s.world.outletA, s.facilityId, `Pass ${short()}`],
    ),
  );
  return id;
}

async function stampOf(s: Setup, productId: string): Promise<string> {
  return asTenant(s.world.tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT updated_at FROM facility_products WHERE id = $1",
      [productId],
    );
    return (rows[0].updated_at as Date).toISOString();
  });
}

/** One-hour all-day seat reservation: floor Rp39.000, at the floor = 29.677. */
const hourSplit = (seatFeeIdr: number) => ({
  kind: "seat_reservation" as const,
  access: "all_day" as const,
  seatFeeIdr,
  creditIdr: 20_000,
  durationMinutes: 60,
});

async function saveProduct(s: Setup, productId: string, seatFeeIdr: number) {
  return setWfcProduct(s.world.context, s.proposer, {
    productId,
    wfc: hourSplit(seatFeeIdr),
    expectedUpdatedAt: await stampOf(s, productId),
  });
}

const switchOn = async (s: Setup, productId: string, isActive = true) =>
  setWfcProductActive(s.world.context, s.proposer, {
    productId,
    isActive,
    expectedUpdatedAt: await stampOf(s, productId),
  });

async function approvalOf(s: Setup, chainId: string) {
  const { rows } = await owner.query(
    `SELECT source_module, action_type, object_type, object_id, outlet_id, payload, status
       FROM approval_requests WHERE tenant_id = $1 AND id = $2`,
    [s.world.tenantId, chainId],
  );
  return rows[0];
}

async function versionCount(s: Setup): Promise<number> {
  const { rows } = await owner.query(
    "SELECT count(*)::int AS n FROM wfc_business_settings WHERE tenant_id = $1",
    [s.world.tenantId],
  );
  return rows[0].n as number;
}

describe("WFC settings: a proposal is bound to its numbers", () => {
  it("mints the version id first and puts every number in a camelCase payload", async () => {
    const s = await setup();
    const proposal = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s),
    );
    expect(proposal.status).toBe("pending");
    expect(proposal.applied).toBe(false);
    expect(proposal.floors).toEqual({ peakIdr: 39_000, offPeakIdr: 20_000 });
    const request = await approvalOf(s, proposal.chainId);
    expect(request).toMatchObject({
      source_module: "wfc",
      action_type: "price_change",
      object_type: "wfc_business_settings",
      object_id: proposal.settingsId,
      outlet_id: s.world.outletA,
      status: "pending",
    });
    const { reason: _reason, ...approved } = numbers(s);
    void _reason;
    expect(request.payload).toEqual({ ...approved, version: 1 });
    // Pending: nothing applies, the outlet still cannot sell.
    expect(await apply(s, proposal.chainId)).toBeNull();
    expect(await versionCount(s)).toBe(0);
  });

  it("is written only after another person approved, once, replay safe", async () => {
    const s = await setup();
    const proposal = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s),
    );
    // The proposer can never approve their own numbers.
    await expect(decide(s, s.proposer, proposal.chainId)).rejects.toThrow();
    await decide(s, s.approver, proposal.chainId);
    const first = await apply(s, proposal.chainId);
    expect(first).toMatchObject({
      id: proposal.settingsId,
      version: 1,
      wfcSeats: 20,
      effectiveFrom: s.today,
    });
    expect(await apply(s, proposal.chainId)).toEqual(first);
    const { rows } = await owner.query(
      "SELECT proposed_by, approved_by, approval_request_id FROM wfc_business_settings WHERE tenant_id = $1",
      [s.world.tenantId],
    );
    expect(rows).toEqual([
      {
        proposed_by: s.proposer,
        approved_by: s.approver,
        approval_request_id: proposal.chainId,
      },
    ]);
    const listed = await listWfcSettings(s.world.context, s.proposer, {
      outletId: s.world.outletA,
    });
    expect(listed.versions.map((v) => v.id)).toEqual([proposal.settingsId]);
    expect(listed.proposals[0]).toMatchObject({
      status: "approved",
      applied: true,
    });
  });

  it("the resolved event applies it; other modules and tenants are ignored", async () => {
    const s = await setup();
    const proposal = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s),
    );
    await decide(s, s.approver, proposal.chainId);
    const { rows } = await owner.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'
          AND event ->> 'name' = 'approval.resolved'
          AND event -> 'payload' ->> 'chainId' = $2`,
      [s.world.tenantId, proposal.chainId],
    );
    expect(rows).toHaveLength(1);
    const event = rows[0].event;
    const other = await createWorld();
    await handleWfcSettingsApprovalResolved(other.context, event);
    await handleWfcSettingsApprovalResolved(s.world.context, {
      ...event,
      payload: { ...event.payload, sourceModule: "inbox" },
    });
    expect(await versionCount(s)).toBe(0);
    await handleWfcSettingsApprovalResolved(s.world.context, event);
    await handleWfcSettingsApprovalResolved(s.world.context, event);
    expect(await versionCount(s)).toBe(1);
  });

  it("a rejection, or an approver without wfc.policy.manage, writes nothing", async () => {
    const s = await setup();
    const rejected = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s),
    );
    await decide(s, s.approver, rejected.chainId, "rejected");
    expect(await apply(s, rejected.chainId)).toBeNull();
    const second = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s),
    );
    await decide(s, s.decideOnly, second.chainId);
    expect(await apply(s, second.chainId)).toBeNull();
    expect(
      await failure(
        applyWfcSettings(s.world.context, s.proposer, {
          chainId: second.chainId,
        }),
      ),
    ).toMatchObject({ status: 409, code: "WFC_SETTINGS_NOT_APPROVED" });
    expect(await versionCount(s)).toBe(0);
  });

  it("one open proposal per outlet; no back-dating; seats never under the quota", async () => {
    const s = await setup();
    await approvedVersion(s);
    for (let i = 0; i < 3; i += 1)
      await createWfcSeat(s.world.context, s.proposer, {
        outletId: s.world.outletA,
        zoneId: s.zoneId,
        code: `K${i}${short()}`.slice(0, 20),
      });
    await putWfcHourlyQuotas(s.world.context, s.proposer, {
      outletId: s.world.outletA,
      quotas: [{ dayOfWeek: 1, hour: 9, seats: 3 }],
    });
    expect(
      await failure(
        proposeWfcSettings(
          s.world.context,
          s.proposer,
          numbers(s, { wfcSeats: 2 }),
        ),
      ),
    ).toMatchObject({ status: 409, code: "WFC_SEATS_BELOW_QUOTA" });
    expect(
      await failure(
        proposeWfcSettings(
          s.world.context,
          s.proposer,
          numbers(s, { effectiveFrom: "2020-01-01" }),
        ),
      ),
    ).toMatchObject({ status: 409, code: "WFC_SETTINGS_BACKDATED" });
    expect(
      await failure(
        proposeWfcSettings(
          s.world.context,
          s.proposer,
          numbers(s, { wfcSeats: 61 }),
        ),
      ),
    ).toMatchObject({ status: 400 });
    const open = await proposeWfcSettings(
      s.world.context,
      s.proposer,
      numbers(s, { wfcSeats: 3 }),
    );
    expect(open.payload.version).toBe(2);
    expect(
      await failure(
        proposeWfcSettings(s.world.context, s.proposer, numbers(s)),
      ),
    ).toMatchObject({ status: 409, code: "WFC_SETTINGS_PENDING" });
    // The quota cannot outgrow the seats waiting for approval.
    expect(
      await failure(
        putWfcHourlyQuotas(s.world.context, s.proposer, {
          outletId: s.world.outletA,
          quotas: [{ dayOfWeek: 1, hour: 10, seats: 4 }],
        }),
      ),
    ).toMatchObject({ status: 409, code: "QUOTA_EXCEEDS_SEATS" });
  });

  it("refuses a caller without wfc.policy.manage and another outlet's scope", async () => {
    const s = await setup();
    expect(
      await failure(
        proposeWfcSettings(s.world.context, s.decideOnly, numbers(s)),
      ),
    ).toMatchObject({ status: 403 });
    expect(await versionCount(s)).toBe(0);
  });
});

describe("WFC price floor on products", () => {
  it("without a version in force the product saves but never switches on", async () => {
    const s = await setup();
    const productId = await seedProduct(s);
    await saveProduct(s, productId, 1);
    expect(await failure(switchOn(s, productId))).toMatchObject({
      status: 409,
      code: "WFC_CONFIG_INCOMPLETE",
    });
  });

  it("one rupiah under the floor is refused on save and on switch-on", async () => {
    const s = await setup();
    const productId = await seedProduct(s);
    await saveProduct(s, productId, 29_676); // saved before any version
    await approvedVersion(s);
    expect(await failure(switchOn(s, productId))).toMatchObject({
      status: 422,
      code: "WFC_PRICE_BELOW_FLOOR",
    });
    expect(await failure(saveProduct(s, productId, 29_676))).toMatchObject({
      status: 422,
      code: "WFC_PRICE_BELOW_FLOOR",
    });
    await saveProduct(s, productId, 29_677);
    expect((await switchOn(s, productId)).isActive).toBe(true);
    // A day pass is used through the longest open day (23 h 59 min here).
    const dayPass = await seedProduct(s);
    expect(
      await failure(
        setWfcProduct(s.world.context, s.proposer, {
          productId: dayPass,
          wfc: {
            ...hourSplit(100_000),
            kind: "day_pass",
            durationMinutes: null,
          },
          expectedUpdatedAt: await stampOf(s, dayPass),
        }),
      ),
    ).toMatchObject({ status: 422, code: "WFC_PRICE_BELOW_FLOOR" });
  });

  it("a coming version with a higher floor switches the product off; a sold pass keeps its numbers", async () => {
    const s = await setup();
    const productId = await seedProduct(s);
    const first = await approvedVersion(s);
    await saveProduct(s, productId, 29_677);
    await switchOn(s, productId);
    // A claim already sold on version 1 (snapshot of price and floor).
    const seat = await createWfcSeat(s.world.context, s.proposer, {
      outletId: s.world.outletA,
      zoneId: s.zoneId,
      code: `K${short()}`,
    });
    const claimId = randomUUID();
    const profileId = (await seedProfile(s.world.tenantId)).id;
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        `INSERT INTO wfc_seat_reservations (id, tenant_id, outlet_id, seat_id, product_id, customer_profile_id,
           kind, access, business_date, slot, status, seat_fee_idr, credit_idr, price_idr,
           settings_version_id, floor_per_hour_idr, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'seat_reservation', 'all_day', '2098-11-08',
           '[2098-11-08T03:00:00Z,2098-11-08T04:00:00Z)', 'pending_payment', 29677, 20000, 49677,
           $7, 39000, '2098-11-08T03:45:00Z')`,
        [
          claimId,
          s.world.tenantId,
          s.world.outletA,
          seat.id,
          productId,
          profileId,
          first.settingsId,
        ],
      ),
    );
    const before = await owner.query(
      "SELECT * FROM wfc_seat_reservations WHERE id = $1",
      [claimId],
    );
    // Version 2 from tomorrow: spend per person up, floor up.
    const tomorrow = new Date(`${s.today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await approvedVersion(s, {
      effectiveFrom: tomorrow.toISOString().slice(0, 10),
      spendPerPersonIdr: 70_000,
    });
    const { rows } = await owner.query(
      "SELECT is_active FROM facility_products WHERE id = $1",
      [productId],
    );
    expect(rows[0].is_active).toBe(false);
    expect(await failure(switchOn(s, productId))).toMatchObject({
      status: 422,
      code: "WFC_PRICE_BELOW_FLOOR",
    });
    const after = await owner.query(
      "SELECT * FROM wfc_seat_reservations WHERE id = $1",
      [claimId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
