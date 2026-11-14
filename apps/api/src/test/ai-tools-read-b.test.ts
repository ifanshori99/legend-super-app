// WS-12 read tools TL-07, TL-08, TL-10, TL-11, TL-12, TL-20 against PostgreSQL
// (bead legend-ktqc; PRD v1.7 §39 TL table, §40 AIG-01, TEN-01..03). Runs the
// real handlers with the restricted app role (RLS enforced) and an
// AccessSnapshot built from the RBAC fixtures. Seeds go through the owner
// connection; event rows (voids, waste, discounts) are inserted with
// `session_replication_role = replica` so the append-only triggers and the
// order/FK parents of the POS tables do not have to be built for a read test.
//
// TL-09 (get_my_payslip) is not registered (no payslip storage exists), so it
// has no test here. TL-07, TL-08 and TL-12 are tested for their access rules
// and against real rows seeded here (customers/tiers, shift assignments,
// shareholder allocations and distribution runs), including rows of another
// tenant and rows the caller may not see (small segments, drafts, other
// employees, unpaid or unapproved shares).
//
// Assumptions (spec/brief leave these open):
// - TL-07 labels a tier segment with the tier name (never with free text typed
//   by a customer); customers are tenant-wide, so there is no outlet reach test.
// - TL-08 start/end times are outlet-local (Asia/Jakarta, +07:00), HH:MM.
// - TL-12 shows only PAID distribution statements (the same set
//   getMyProfitShareService returns); amount == the statement's gross (the
//   seeded tax is 0, so gross == net), sharePct == share_bp / 100.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  roleAssignmentSchema,
} from "@starter/shared/access";
import { AI_TOOL_IO, TOOL_MAX_ROWS, type AiToolCode } from "@starter/shared/ai";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { readToolsB } from "../services/ai-tools/read-b/index.ts";
import {
  sopQueryTokens,
  sopSnippet,
} from "../services/ai-tools/read-b/tl-10-search-sop.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";
import { getMyProfitShareService } from "../services/profit-share-distribution.service.ts";

const fx = cafeLegendAccessFixtures;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = fx.outletIds.bandung;
const outletB = fx.outletIds.bandung2;
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const publisher = randomUUID();
const otherEmployeeUser = randomUUID();
const tenantObject = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  replica = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

function ctxFor(
  userKey: keyof typeof fx.users,
  extraAssignments: typeof fx.assignments = [],
): AiToolContext {
  return {
    access: resolveAccessSnapshot({
      tenant: tenantObject,
      userId: fx.users[userKey].id,
      assignments: [...fx.assignments, ...extraAssignments],
      roles: fx.roles,
      org: fx.org,
      mfaVerified: false,
      now: fx.now,
    }),
    channel: "tanya_ai",
    mcpClientId: null,
    now: fx.now,
  };
}

type ToolRow = Record<string, unknown>;
type ToolOut = {
  results: ToolRow[];
  anomalies: ToolRow[];
  rows: ToolRow[];
  sources: ToolRow[];
  shifts: ToolRow[];
  segmentBy?: string;
  segments: unknown[];
  distributions: unknown[];
  truncated: boolean;
};

/** Calls the registered handler and checks the result against the catalog schema. */
async function call(
  code: AiToolCode,
  userKey: keyof typeof fx.users,
  input: Record<string, unknown>,
) {
  const handler = readToolsB[code];
  if (!handler) throw new Error(`No handler for ${code}`);
  const parsedInput = AI_TOOL_IO[code].input.parse(input);
  const output = await handler(ctxFor(userKey), parsedInput);
  return AI_TOOL_IO[code].output.parse(output) as unknown as ToolOut;
}

const forbidden = { code: "AI_TOOL_FORBIDDEN", status: 403 };

type Segment = {
  code: string;
  label: string;
  customerCount: number;
  avgSpendIdr: number;
};
type ShiftRow = {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  outletId: string;
  date: string;
  startTime: string;
  endTime: string;
};
type DistributionRow = {
  periodLabel: string;
  sharePct: string;
  amountIdr: number;
  status: string;
};

// ---- Seeds -----------------------------------------------------------------

const createdSop: string[] = [];
const createdFacilities: { tenant: string; id: string }[] = [];
let employeeId = "";
let otherEmployeeId = "";
let kitchenLeadEmployeeId = "";
let stationOutletB = "";

async function seedUser(id: string) {
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Read B', $2) ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@example.test`],
  );
}

async function seedEmployee(userId: string, outletId: string): Promise<string> {
  const id = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Read B', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenantId, userId, `RB-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

async function seedSop(options: {
  tenant?: string;
  title: string;
  body: string;
  stationId?: string | null;
  version?: number;
  supersedes?: string;
  lineage?: string;
}): Promise<string> {
  const id = randomUUID();
  const tenant = options.tenant ?? tenantId;
  const version = options.version ?? 1;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO sop_documents (id, tenant_id, lineage_id, version, supersedes_id, station_id, title, body,
                                  requires_acknowledgement, effective_from, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, '2026-01-01', $9)`,
      [
        id,
        tenant,
        options.lineage ?? id,
        version,
        options.supersedes ?? null,
        options.stationId ?? null,
        options.title,
        options.body,
        publisher,
      ],
    ),
  );
  createdSop.push(id);
  return id;
}

type SeededFacility = {
  id: string;
  areaId: string;
  productId: string;
  units: string[];
};

async function seedFacility(options: {
  tenant: string;
  outletId: string;
  name: string;
}): Promise<SeededFacility> {
  const id = randomUUID();
  const areaId = randomUUID();
  const productId = randomUUID();
  const units = [randomUUID(), randomUUID()];
  await asOwner(options.tenant, async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'shower', 60, 10, 10, $5, $6, $7)`,
      [
        id,
        options.tenant,
        options.outletId,
        options.name,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "08:00",
            closesAt: "20:00",
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
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area', 0)`,
      [areaId, options.tenant, options.outletId, id],
    );
    for (const [index, unitId] of units.entries())
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)`,
        [
          unitId,
          options.tenant,
          options.outletId,
          id,
          areaId,
          `U${index + 1}`,
          index,
        ],
      );
    await client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
       VALUES ($1, $2, $3, $4, 'Tiket', 'single', 50000, 1)`,
      [productId, options.tenant, options.outletId, id],
    );
  });
  createdFacilities.push({ tenant: options.tenant, id });
  return { id, areaId, productId, units };
}

async function seedTicket(
  tenant: string,
  outletId: string,
  facility: SeededFacility,
  input: {
    unit: number;
    startsAt: string;
    minutes: number;
    status: string;
    source?: string;
    overtimeFee?: number;
  },
) {
  const start = Date.parse(input.startsAt);
  const end = start + input.minutes * 60_000;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes,
                                   status, overtime_fee_idr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 10, $13, $14)`,
      [
        randomUUID(),
        tenant,
        outletId,
        facility.id,
        facility.areaId,
        facility.units[input.unit],
        randomUUID(),
        facility.productId,
        input.source ?? "purchase",
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        new Date(end + 10 * 60_000).toISOString(),
        input.status,
        input.overtimeFee ?? 0,
      ],
    ),
  );
}

async function seedVoids(tenant: string, outletId: string, isoTimes: string[]) {
  await asOwner(
    tenant,
    async (client) => {
      for (const [index, at] of isoTimes.entries())
        await client.query(
          `INSERT INTO pos_order_voids (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason,
                                        reason_note, requested_by, approved_by, approval_request_id, voided_at)
           VALUES ($1, $2, $3, $4, $5, 25000, 'wrong_item', 'salah input', 'kasir-a', 'spv-b', $6, $7)`,
          [
            randomUUID(),
            tenant,
            outletId,
            randomUUID(),
            `RB-${index}-${randomUUID().slice(0, 6)}`,
            randomUUID(),
            at,
          ],
        );
    },
    true,
  );
}

async function seedWaste(
  tenant: string,
  outletId: string,
  isoTimes: string[],
  valueIdr: number,
) {
  await asOwner(
    tenant,
    async (client) => {
      for (const at of isoTimes)
        await client.query(
          `INSERT INTO waste_logs (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity,
                                   reason, value_idr, logged_by, occurred_at)
           VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'spoiled', $6, $7, $8)`,
          [
            randomUUID(),
            tenant,
            outletId,
            randomUUID(),
            randomUUID(),
            valueIdr,
            publisher,
            at,
          ],
        );
    },
    true,
  );
}

async function seedDiscounts(
  tenant: string,
  outletId: string,
  isoTimes: string[],
  amountIdr: number,
) {
  await asOwner(
    tenant,
    async (client) => {
      for (const at of isoTimes)
        await client.query(
          `INSERT INTO pos_order_discounts (id, tenant_id, outlet_id, order_id, source, kind, amount_idr, reason,
                                            reason_note, applied_by, created_at)
           VALUES ($1, $2, $3, $4, 'manual', 'amount', $5, 'loyal', 'pelanggan setia', 'kasir-a', $6)`,
          [randomUUID(), tenant, outletId, randomUUID(), amountIdr, at],
        );
    },
    true,
  );
}

// ---- Behaviour seeds: TL-07 customers, TL-08 shifts, TL-12 profit share -----
// All rows are written with `session_replication_role = replica` (no FK or
// append-only trigger setup needed); CHECK constraints still apply.

const rbSuffix = randomUUID().slice(0, 6);
const PII_NAME = "Pelanggan Rahasia RB";
const goldName = `RB Emas ${rbSuffix}`;
const silverName = `RB Perak ${rbSuffix}`;
const foreignTierName = `RB Asing ${rbSuffix}`;
// Mean is exactly 350000.
const GOLD_SPENDS = [200_000, 300_000, 350_000, 350_000, 400_000, 500_000];
const createdTiers: { tenant: string; id: string }[] = [];

async function seedTier(
  tenant: string,
  name: string,
  rank: number,
): Promise<string> {
  const id = randomUUID();
  await asOwner(
    tenant,
    (client) =>
      client.query(
        `INSERT INTO loyalty_tiers
           (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits, is_active)
         VALUES ($1, $2, $3, $4, 1000000000, 1000000, $5::jsonb, true)`,
        [
          id,
          tenant,
          name,
          rank,
          JSON.stringify({
            pointsMultiplierBp: 10_000,
            birthdayRewardPoints: 0,
            reservationPriority: false,
            exclusivePromotions: false,
            facilityFreeAccessQuota: 0,
          }),
        ],
      ),
    true,
  );
  createdTiers.push({ tenant, id });
  return id;
}

async function seedCustomers(
  tenant: string,
  tierId: string | null,
  spends: number[],
  lastVisitAt = "2026-10-20T03:00:00Z",
  visits = 3,
) {
  await asOwner(
    tenant,
    async (client) => {
      for (const spend of spends)
        await client.query(
          `INSERT INTO customer_profiles
             (id, tenant_id, name, membership_status, whatsapp_verified_at, lifetime_spend_idr,
              visits_count, first_visit_at, last_visit_at, tier_id)
           VALUES ($1, $2, $3, 'active', '2026-01-02T00:00:00Z', $4, $5, '2026-01-05T03:00:00Z', $6, $7)`,
          [randomUUID(), tenant, PII_NAME, spend, visits, lastVisitAt, tierId],
        );
    },
    true,
  );
}

const SHIFT_SEED = "rb-shift-seed";
let foreignEmployeeId = "";
let outletC = "";
const wib = (date: string, time: string) =>
  new Date(`${date}T${time}:00+07:00`).toISOString();

async function seedShift(
  tenant: string,
  outletId: string,
  employee: string,
  date: string,
  start: string,
  end: string,
  status: "published" | "draft" = "published",
) {
  await asOwner(
    tenant,
    (client) =>
      client.query(
        `INSERT INTO shift_assignments
           (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes, status, source,
            published_by, published_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0, $7, 'user', $8, $9, $10)`,
        [
          randomUUID(),
          tenant,
          outletId,
          employee,
          date,
          JSON.stringify([
            { startsAt: wib(date, start), endsAt: wib(date, end) },
          ]),
          status,
          status === "draft" ? null : publisher,
          status === "draft" ? null : "2026-10-01T00:00:00Z",
          SHIFT_SEED,
        ],
      ),
    true,
  );
}

// Fixture users need DB role assignments because listShiftAssignments reads
// them from the database, not from the in-memory fixtures. Custom roles with
// exactly the permission the tool needs keep this independent of templates.
// valid_from is before fx.now (the tool's clock), not before the wall clock.
const grantedUsers: string[] = [];
const grantedRoles: string[] = [];
async function grantPermission(
  userId: string,
  permission: string,
  outletScope: string | null,
) {
  const roleId = randomUUID();
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `RB jadwal ${roleId.slice(0, 8)}`,
        JSON.stringify([permission]),
        JSON.stringify(["tenant", "outlet"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, '2026-01-01T00:00:00Z', $2)`,
      [
        tenantId,
        userId,
        roleId,
        outletScope ? "outlet" : "tenant",
        outletScope,
      ],
    );
  });
  grantedRoles.push(roleId);
  grantedUsers.push(userId);
}

const psTrack = new Map<
  string,
  { entityIds: string[]; holderIds: string[]; legalIds: string[] }
>();
function tracked(tenant: string) {
  let found = psTrack.get(tenant);
  if (!found) {
    found = { entityIds: [], holderIds: [], legalIds: [] };
    psTrack.set(tenant, found);
  }
  return found;
}

async function seedHolder(
  tenant: string,
  userId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await asOwner(
    tenant,
    (client) =>
      client.query(
        `INSERT INTO shareholders (tenant_id, id, user_id, name, type, status, created_by)
         VALUES ($1, $2, $3, $4, 'person', 'active', $5)`,
        [tenant, id, userId, name, randomUUID()],
      ),
    true,
  );
  tracked(tenant).holderIds.push(id);
  return id;
}

async function seedEntity(
  tenant: string,
  status: "approved" | "pending_approval",
  allocations: { holderId: string; bp: number }[],
): Promise<string> {
  const legalId = randomUUID();
  const entityId = randomUUID();
  const decided = status === "approved";
  await asOwner(
    tenant,
    async (client) => {
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
        [legalId, tenant, `RB PT ${legalId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO profit_entities
           (tenant_id, id, name, type, legal_entity_id, reserve_bp, frequency, tax_withholding_bp, created_by)
         VALUES ($1, $2, $3, 'legal_entity', $4, 0, 'quarterly', 0, $5)`,
        [
          tenant,
          entityId,
          `RB entitas ${entityId.slice(0, 6)}`,
          legalId,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO share_allocation_versions
           (tenant_id, profit_entity_id, version, effective_from, status, requested_by, decided_by,
            decided_at, idempotency_key)
         VALUES ($1, $2, 1, '2025-01-01', $3, $7, $4, $5, $6)`,
        [
          tenant,
          entityId,
          status,
          decided ? randomUUID() : null,
          decided ? "2025-01-01T00:00:00Z" : null,
          `rb-${randomUUID()}`,
          randomUUID(),
        ],
      );
      for (const [position, row] of allocations.entries())
        await client.query(
          `INSERT INTO share_allocations
             (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
           VALUES ($1, $2, 1, $3, $4, $5)`,
          [tenant, entityId, row.holderId, row.bp, position],
        );
    },
    true,
  );
  tracked(tenant).entityIds.push(entityId);
  tracked(tenant).legalIds.push(legalId);
  return entityId;
}

/** Tax is 0, so gross == net. distributable = profit - reserve = sum of gross. */
async function seedRun(
  tenant: string,
  entityId: string,
  run: {
    period: string;
    profit: number;
    reserve: number;
    status: "approved" | "paid";
    linePaid: boolean;
    lines: { holderId: string; userId: string; bp: number; gross: number }[];
  },
) {
  const runId = randomUUID();
  const distributable = run.profit - run.reserve;
  const paid = run.status === "paid";
  await asOwner(
    tenant,
    async (client) => {
      await client.query(
        `INSERT INTO distribution_runs
           (tenant_id, id, profit_entity_id, fiscal_period_id, fiscal_period_version, period, type, basis,
            status, share_version, period_net_profit_idr, reserve_idr, distributable_idr, total_gross_idr,
            total_tax_withheld_idr, total_net_idr, unabsorbed_idr, carry_deducted_idr, tax_withholding_bp,
            requested_by, approved_by, approved_at, paid_at, journal_entry_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, $5, 'regular', 'closed_period_net_profit', $6, 1, $7, $8, $9, $9,
                 0, $9, 0, 0, 0, $13, $14, '2026-01-01T00:00:00Z', $10, $11, $12)`,
        [
          tenant,
          runId,
          entityId,
          randomUUID(),
          run.period,
          run.status,
          run.profit,
          run.reserve,
          distributable,
          paid ? "2026-01-02T00:00:00Z" : null,
          paid ? randomUUID() : null,
          `rb-${randomUUID()}`,
          randomUUID(),
          randomUUID(),
        ],
      );
      for (const [position, line] of run.lines.entries())
        await client.query(
          `INSERT INTO distribution_lines
             (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr, tax_withheld_idr, net_idr,
              carry_deducted_idr, payment_status, payment_ref, paid_at, paid_by, recipient_user_id, position)
           VALUES ($1, $2, $3, $4, $5, 0, $5, 0, $6, $7, $8, $9, $10, $11)`,
          [
            tenant,
            runId,
            line.holderId,
            line.bp,
            line.gross,
            run.linePaid ? "paid" : "pending",
            run.linePaid ? "RB-REF" : null,
            run.linePaid ? "2026-01-02T00:00:00Z" : null,
            run.linePaid ? randomUUID() : null,
            line.userId,
            position,
          ],
        );
    },
    true,
  );
}

const holderBUser = randomUUID();
const behaviorUsers = [
  fx.users.hr.id,
  fx.users.outletManager.id,
  fx.users.shareholder.id,
  holderBUser,
];

async function seedBehavior() {
  for (const id of behaviorUsers) await seedUser(id);

  // TL-07: gold (6), silver (4: under the minimum), an untiered cohort of 8
  // identical customers (lands in one segment for any bucket rule) and a
  // foreign tenant's tier with 8 customers.
  const gold = await seedTier(tenantId, goldName, 9101);
  const silver = await seedTier(tenantId, silverName, 9102);
  const foreignTier = await seedTier(otherTenant, foreignTierName, 9101);
  await seedCustomers(tenantId, gold, GOLD_SPENDS);
  await seedCustomers(tenantId, silver, [900_000, 900_000, 900_000, 900_000]);
  await seedCustomers(
    tenantId,
    null,
    Array<number>(8).fill(2_000_000),
    "2026-10-30T03:00:00Z",
    9,
  );
  await seedCustomers(otherTenant, foreignTier, Array<number>(8).fill(777_000));

  // TL-08 shifts. WIB outlet-local times.
  await grantPermission(fx.users.hr.id, "hr.schedule.manage", null);
  await grantPermission(
    fx.users.outletManager.id,
    "hr.schedule.manage",
    outletA,
  );
  await grantPermission(fx.users.employee.id, "self.schedule.view", outletA);
  foreignEmployeeId = randomUUID();
  await asOwner(
    otherTenant,
    (client) =>
      client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, NULL, $3, 'Karyawan Asing RB', $4, 'pkwtt', '2025-03-01', 'active')`,
        [
          foreignEmployeeId,
          otherTenant,
          `RBF-${rbSuffix.toUpperCase()}`,
          otherOutlet,
        ],
      ),
    true,
  );
  // The outlet manager's tool reach is outlet A only (in-memory outlet_manager
  // snapshot). A second DB assignment gives them outlet B in the HRIS
  // service; the tool must still not report outlet B.
  await grantPermission(
    fx.users.outletManager.id,
    "hr.schedule.manage",
    outletB,
  );
  // Row-cap case: a third outlet with 260 shifts in the week of 2026-11-02.
  outletC = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet RB C', address, 'Asia/Jakarta', opening_hours
       FROM outlets WHERE id = $2`,
    [outletC, outletA, `RBC-${rbSuffix}`.toUpperCase()],
  );
  await asOwner(
    tenantId,
    (client) =>
      client.query(
        `INSERT INTO shift_assignments
           (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes, status, source,
            published_by, published_at, created_by)
         SELECT gen_random_uuid(), $1, $2, $3, '2026-11-03', $4::jsonb, 0, 'published', 'user', $5,
                '2026-10-01T00:00:00Z', $6
           FROM generate_series(1, 260)`,
        [
          tenantId,
          outletC,
          otherEmployeeId,
          JSON.stringify([
            {
              startsAt: wib("2026-11-03", "07:00"),
              endsAt: wib("2026-11-03", "15:00"),
            },
          ]),
          publisher,
          SHIFT_SEED,
        ],
      ),
    true,
  );
  await seedShift(
    tenantId,
    outletA,
    employeeId,
    "2026-11-04",
    "08:00",
    "16:00",
  );
  await seedShift(
    tenantId,
    outletB,
    kitchenLeadEmployeeId,
    "2026-11-05",
    "09:00",
    "17:00",
  );
  await seedShift(
    tenantId,
    outletA,
    employeeId,
    "2026-10-06",
    "08:00",
    "16:00",
  );
  await seedShift(
    tenantId,
    outletA,
    employeeId,
    "2026-10-07",
    "09:00",
    "17:00",
    "draft",
  );
  await seedShift(
    tenantId,
    outletA,
    employeeId,
    "2026-10-20",
    "08:00",
    "16:00",
  );
  await seedShift(
    tenantId,
    outletA,
    otherEmployeeId,
    "2026-10-06",
    "10:00",
    "18:00",
  );
  await seedShift(
    tenantId,
    outletB,
    kitchenLeadEmployeeId,
    "2026-10-08",
    "06:00",
    "14:00",
  );
  await seedShift(
    otherTenant,
    otherOutlet,
    foreignEmployeeId,
    "2026-10-09",
    "05:30",
    "13:30",
  );

  // TL-12: holder A is the shareholder fixture user, B another person.
  // Entity 1 (approved 60/40): paid 2026-03, paid 2026-09, paid 2025-12 and
  // an approved run (2026-06) whose lines are NOT paid. Entity 2 has only a
  // pending (unapproved) version giving A 33.33%. The foreign tenant pays the
  // same login 9,999,000 in 2026-04.
  const holderA = await seedHolder(
    tenantId,
    fx.users.shareholder.id,
    "RB Pemegang A",
  );
  const holderB = await seedHolder(tenantId, holderBUser, "RB Pemegang B");
  const entity = await seedEntity(tenantId, "approved", [
    { holderId: holderA, bp: 6000 },
    { holderId: holderB, bp: 4000 },
  ]);
  const split = (a: number, b: number) => [
    { holderId: holderA, userId: fx.users.shareholder.id, bp: 6000, gross: a },
    { holderId: holderB, userId: holderBUser, bp: 4000, gross: b },
  ];
  await seedRun(tenantId, entity, {
    period: "2026-03",
    profit: 12_000_000,
    reserve: 2_000_000,
    status: "paid",
    linePaid: true,
    lines: split(6_000_000, 4_000_000),
  });
  await seedRun(tenantId, entity, {
    period: "2026-09",
    profit: 9_000_000,
    reserve: 1_500_000,
    status: "paid",
    linePaid: true,
    lines: split(4_500_000, 3_000_000),
  });
  await seedRun(tenantId, entity, {
    period: "2025-12",
    profit: 6_000_000,
    reserve: 1_000_000,
    status: "paid",
    linePaid: true,
    lines: split(3_000_000, 2_000_000),
  });
  await seedRun(tenantId, entity, {
    period: "2026-06",
    profit: 8_000_000,
    reserve: 1_000_000,
    status: "approved",
    linePaid: false,
    lines: split(4_200_000, 2_800_000),
  });
  // Two entities paying the same holder in 2027-03.
  const entity2 = await seedEntity(tenantId, "approved", [
    { holderId: holderA, bp: 5000 },
    { holderId: holderB, bp: 5000 },
  ]);
  await seedRun(tenantId, entity, {
    period: "2027-03",
    profit: 3_000_000,
    reserve: 0,
    status: "paid",
    linePaid: true,
    lines: split(1_800_000, 1_200_000),
  });
  await seedRun(tenantId, entity2, {
    period: "2027-03",
    profit: 2_000_000,
    reserve: 0,
    status: "paid",
    linePaid: true,
    lines: [
      {
        holderId: holderA,
        userId: fx.users.shareholder.id,
        bp: 5000,
        gross: 1_000_000,
      },
      { holderId: holderB, userId: holderBUser, bp: 5000, gross: 1_000_000 },
    ],
  });
  await seedEntity(tenantId, "pending_approval", [
    { holderId: holderA, bp: 3333 },
    { holderId: holderB, bp: 6667 },
  ]);
  const foreignHolder = await seedHolder(
    otherTenant,
    fx.users.shareholder.id,
    "RB Pemegang Asing",
  );
  const foreignEntity = await seedEntity(otherTenant, "approved", [
    { holderId: foreignHolder, bp: 10_000 },
  ]);
  await seedRun(otherTenant, foreignEntity, {
    period: "2026-04",
    profit: 10_999_000,
    reserve: 1_000_000,
    status: "paid",
    linePaid: true,
    lines: [
      {
        holderId: foreignHolder,
        userId: fx.users.shareholder.id,
        bp: 10_000,
        gross: 9_999_000,
      },
    ],
  });
}

async function cleanupBehavior() {
  for (const [tenant, ids] of psTrack)
    await asOwner(
      tenant,
      async (client) => {
        await client.query(
          `DELETE FROM distribution_lines WHERE tenant_id = $1 AND distribution_run_id IN
             (SELECT id FROM distribution_runs WHERE tenant_id = $1 AND profit_entity_id = ANY($2))`,
          [tenant, ids.entityIds],
        );
        for (const table of [
          "distribution_runs",
          "share_allocations",
          "share_allocation_versions",
        ])
          await client.query(
            `DELETE FROM ${table} WHERE tenant_id = $1 AND profit_entity_id = ANY($2)`,
            [tenant, ids.entityIds],
          );
        await client.query(
          "DELETE FROM profit_entities WHERE tenant_id = $1 AND id = ANY($2)",
          [tenant, ids.entityIds],
        );
        await client.query(
          "DELETE FROM shareholders WHERE tenant_id = $1 AND id = ANY($2)",
          [tenant, ids.holderIds],
        );
        await client.query(
          "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2)",
          [tenant, ids.legalIds],
        );
      },
      true,
    );
  for (const tenant of [tenantId, otherTenant])
    await asOwner(
      tenant,
      async (client) => {
        await client.query(
          "DELETE FROM shift_assignments WHERE tenant_id = $1 AND created_by = $2",
          [tenant, SHIFT_SEED],
        );
        await client.query(
          "DELETE FROM customer_profiles WHERE tenant_id = $1 AND name = $2",
          [tenant, PII_NAME],
        );
      },
      true,
    );
  if (outletC)
    await owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      outletC,
    ]);
  if (foreignEmployeeId)
    await asOwner(
      otherTenant,
      (client) =>
        client.query("DELETE FROM employees WHERE tenant_id = $1 AND id = $2", [
          otherTenant,
          foreignEmployeeId,
        ]),
      true,
    );
  for (const tier of createdTiers)
    await asOwner(
      tier.tenant,
      (client) =>
        client.query(
          "DELETE FROM loyalty_tiers WHERE tenant_id = $1 AND id = $2",
          [tier.tenant, tier.id],
        ),
      true,
    );
  await asOwner(tenantId, (client) =>
    client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, grantedUsers],
    ),
  );
  await asOwner(tenantId, (client) =>
    client.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenantId,
      grantedRoles,
    ]),
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [behaviorUsers]);
}

let facilityA: SeededFacility;
const PERIOD = { from: "2026-10-05", to: "2026-10-05" };
const ANOMALY_PERIOD = { from: "2026-09-15", to: "2026-09-21" };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(fx.tenantId).toBe(tenantId);
  expect(outletA).toBe(cafeLegendPlatformFixtures.outlets[0].id);
  expect(outletB).toBe(cafeLegendPlatformFixtures.outlets[1].id);

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Read B other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `read-b-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });

  for (const id of [
    publisher,
    fx.users.employee.id,
    fx.users.kitchenLead.id,
    otherEmployeeUser,
  ])
    await seedUser(id);
  employeeId = await seedEmployee(fx.users.employee.id, outletA);
  otherEmployeeId = await seedEmployee(otherEmployeeUser, outletA);
  // Manager of outlet A whose own home outlet is B (see the TL-10 two-reach test).
  kitchenLeadEmployeeId = await seedEmployee(fx.users.kitchenLead.id, outletB);

  stationOutletB = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Read B stasiun', 'coffee_bar')`,
      [stationOutletB, tenantId, outletB],
    ),
  );

  // TL-20 data: facility in outlet A (2 units, open 08:00-20:00), one in the
  // other tenant.
  facilityA = await seedFacility({
    tenant: tenantId,
    outletId: outletA,
    name: "Read B Shower",
  });
  // 2026-10-05 10:00 WIB = 03:00Z. Two completed hours on two units, an
  // overtime fee, one cancelled and one hold (neither counts), one package
  // ticket (counts as a session, no price) and one on the next day.
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
    overtimeFee: 5000,
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 1,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 1,
    startsAt: "2026-10-05T06:00:00Z",
    minutes: 60,
    status: "cancelled",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T08:00:00Z",
    minutes: 60,
    status: "pending_payment",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T10:00:00Z",
    minutes: 60,
    status: "issued",
    source: "package",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-06T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  const foreign = await seedFacility({
    tenant: otherTenant,
    outletId: otherOutlet,
    name: "Read B Foreign",
  });
  await seedTicket(otherTenant, otherOutlet, foreign, {
    unit: 0,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  // 201 facilities in outlet B for the row cap.
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       SELECT gen_random_uuid(), $1, $2, 'Read B Cap ' || lpad(n::text, 3, '0'), 'locker', 60, 10, 10, $3::jsonb, $4::jsonb, $5::jsonb
         FROM generate_series(1, 201) n`,
      [
        tenantId,
        outletB,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "08:00",
            closesAt: "20:00",
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
    ),
  );

  // TL-11 data (period 2026-09-15..21, baseline 2026-09-08..14, WIB days).
  const inPeriod = [
    "2026-09-17T05:00:00Z",
    "2026-09-17T06:00:00Z",
    "2026-09-18T05:00:00Z",
    "2026-09-19T05:00:00Z",
  ];
  await seedVoids(tenantId, outletA, [...inPeriod, "2026-09-10T05:00:00Z"]);
  await seedVoids(tenantId, outletB, inPeriod);
  await seedVoids(otherTenant, otherOutlet, [...inPeriod, ...inPeriod]);
  await seedWaste(tenantId, outletA, inPeriod.slice(0, 3), 100_000);
  await seedWaste(tenantId, outletA, ["2026-09-10T05:00:00Z"], 100_000);
  await seedDiscounts(tenantId, outletA, inPeriod.slice(0, 3), 20_000);
  // Below the minimum event count: never reported.
  await seedVoids(tenantId, outletB, ["2026-09-10T05:00:00Z"]);

  await seedBehavior();
});

afterAll(async () => {
  await cleanupBehavior();
  await asOwner(
    tenantId,
    async (client) => {
      for (const table of [
        "pos_order_voids",
        "waste_logs",
        "pos_order_discounts",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2)`,
          [tenantId, [outletA, outletB]],
        );
    },
    true,
  );
  await asOwner(
    otherTenant,
    (client) =>
      client.query("DELETE FROM pos_order_voids WHERE tenant_id = $1", [
        otherTenant,
      ]),
    true,
  );
  for (const f of createdFacilities)
    await asOwner(f.tenant, async (client) => {
      for (const table of [
        "access_tickets",
        "facility_products",
        "facility_units",
        "facility_areas",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
          [f.tenant, f.id],
        );
      await client.query(
        "DELETE FROM facilities WHERE tenant_id = $1 AND id = $2",
        [f.tenant, f.id],
      );
    });
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND name LIKE 'Read B Cap %'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM sop_documents WHERE tenant_id = $1 AND published_by = $2",
      [tenantId, publisher],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, [employeeId, otherEmployeeId, kitchenLeadEmployeeId]],
    );
    await client.query(
      "DELETE FROM stations WHERE tenant_id = $1 AND id = $2",
      [tenantId, stationOutletB],
    );
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM sop_documents WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [
    [publisher, fx.users.employee.id, otherEmployeeUser],
  ]);
  await owner.end();
});

// ---- Registry --------------------------------------------------------------

describe("readToolsB registry", () => {
  it("registers TL-07, 08, 10, 11, 12, 20 and leaves TL-09 to the engineer", () => {
    expect(Object.keys(readToolsB).sort()).toEqual([
      "TL-07",
      "TL-08",
      "TL-10",
      "TL-11",
      "TL-12",
      "TL-20",
    ]);
  });
});

// ---- TL-07 -----------------------------------------------------------------

describe("TL-07 get_customer_segments", () => {
  const find = (segments: Segment[], name: string) =>
    segments.find((s) => s.label.includes(name) || s.code.includes(name));

  it("marketing sees own-tenant tier segments with count and average spend, aggregate only", async () => {
    const out = await call("TL-07", "marketing", { segmentBy: "tier" });
    const segments = out.segments as Segment[];
    const gold = find(segments, goldName);
    expect(gold).toMatchObject({ customerCount: 6, avgSpendIdr: 350_000 });
    expect(out.sources.length).toBeGreaterThanOrEqual(1);
    // No identity or contact field, no customer-typed text.
    expect(JSON.stringify(out)).not.toMatch(/Rahasia|email|phone|whatsapp/i);
    for (const segment of segments)
      expect(Object.keys(segment).sort()).toEqual([
        "avgSpendIdr",
        "code",
        "customerCount",
        "label",
      ]);
  });

  it("never returns a segment under the minimum size, nor another tenant's tier", async () => {
    const out = await call("TL-07", "marketing", { segmentBy: "tier" });
    const segments = out.segments as Segment[];
    // Silver has 4 customers (< CUSTOMER_SEGMENT_MIN_SIZE = 5).
    expect(find(segments, silverName)).toBeUndefined();
    // The foreign tenant's tier has 8 customers but is not ours.
    expect(find(segments, foreignTierName)).toBeUndefined();
    for (const segment of segments)
      expect(segment.customerCount).toBeGreaterThanOrEqual(5);
  });

  it.each(["recency", "frequency", "spend"] as const)(
    "segments by %s: non-empty, every segment at or above the minimum, no identity",
    async (segmentBy) => {
      const out = await call("TL-07", "marketing", { segmentBy });
      const segments = out.segments as Segment[];
      expect(out.segmentBy).toBe(segmentBy);
      // The 8 untiered customers share spend, visits and last visit.
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.some((s) => s.customerCount >= 8)).toBe(true);
      for (const segment of segments)
        expect(segment.customerCount).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(out)).not.toMatch(/Rahasia/);
    },
  );

  it("a role without crm.customer.view is forbidden", async () => {
    await expect(
      call("TL-07", "employee", { segmentBy: "tier" }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-08 -----------------------------------------------------------------

describe("TL-08 get_shift_schedule", () => {
  const period = { from: "2026-10-05", to: "2026-10-11" };
  const rowsOf = (out: ToolOut) => out.shifts as unknown as ShiftRow[];
  const key = (row: ShiftRow) => `${row.date} ${row.startTime}-${row.endTime}`;

  it("an employee reads only their own published shifts of the period (no id, or their own id)", async () => {
    for (const input of [{ period }, { period, employeeId }]) {
      const out = await call("TL-08", "employee", input);
      const rows = rowsOf(out);
      // One published shift in the week; the draft (10-07), the shift outside
      // the period (10-20) and the colleague's shift (10-06 10:00) are absent.
      expect(rows.map(key)).toEqual(["2026-10-06 08:00-16:00"]);
      expect(rows[0]!.employeeId.toLowerCase()).toBe(employeeId.toLowerCase());
      expect(rows[0]!.outletId.toLowerCase()).toBe(outletA.toLowerCase());
      expect(out.truncated).toBe(false);
    }
  });

  it("an employee asking for another employee is forbidden, never rewritten", async () => {
    await expect(
      call("TL-08", "employee", { period, employeeId: otherEmployeeId }),
    ).rejects.toMatchObject(forbidden);
  });

  it("a manager with hr.schedule.manage reads every outlet of the tenant, sorted, never another tenant", async () => {
    const out = await call("TL-08", "hr", { period });
    const rows = rowsOf(out);
    const keys = rows.map(key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "2026-10-06 08:00-16:00",
        "2026-10-06 10:00-18:00",
        "2026-10-08 06:00-14:00",
      ]),
    );
    // Outside the period, and the foreign tenant's 05:30 shift of 10-09.
    expect(keys.some((k) => k.startsWith("2026-10-20"))).toBe(false);
    expect(keys).not.toContain("2026-10-09 05:30-13:30");
    expect(rows.some((r) => r.outletId.toLowerCase() === otherOutlet)).toBe(
      false,
    );
    expect(JSON.stringify(out)).not.toContain("Karyawan Asing");
    const order = rows.map((r) => `${r.date} ${r.startTime}`);
    expect(order).toEqual([...order].sort());
    expect(out.truncated).toBe(false);
  });

  it("a manager can narrow to an outlet in reach", async () => {
    const out = await call("TL-08", "hr", { period, outletIds: [outletB] });
    const rows = rowsOf(out);
    expect(rows.map(key)).toContain("2026-10-08 06:00-14:00");
    for (const row of rows)
      expect(row.outletId.toLowerCase()).toBe(outletB.toLowerCase());
  });

  it("an outlet manager sees only their outlet and is denied another outlet filter", async () => {
    const out = await call("TL-08", "outletManager", { period });
    const rows = rowsOf(out);
    expect(rows.map(key)).toContain("2026-10-06 10:00-18:00");
    for (const row of rows)
      expect(row.outletId.toLowerCase()).toBe(outletA.toLowerCase());
    await expect(
      call("TL-08", "outletManager", { period, outletIds: [outletB] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("an outlet manager with a second assignment at outlet B still sees no outlet B shift", async () => {
    // Outlet B holds a shift (10-08 06:00-14:00) that the HRIS service would
    // return for this user's DB assignment; the tool reach is outlet A only.
    const out = await call("TL-08", "outletManager", { period });
    const rows = rowsOf(out);
    expect(rows.map(key)).toContain("2026-10-06 10:00-18:00");
    expect(rows.map(key)).not.toContain("2026-10-08 06:00-14:00");
    expect(
      rows.some((r) => r.outletId.toLowerCase() === outletB.toLowerCase()),
    ).toBe(false);
  });

  it("filtering to two outlets is not made truncated by many rows of a third outlet", async () => {
    const out = await call("TL-08", "hr", {
      period: { from: "2026-11-02", to: "2026-11-08" },
      outletIds: [outletA, outletB],
    });
    expect(rowsOf(out).map(key)).toEqual([
      "2026-11-04 08:00-16:00",
      "2026-11-05 09:00-17:00",
    ]);
    expect(out.truncated).toBe(false);
  });

  it("a week without shifts is an empty, non-truncated list", async () => {
    const out = await call("TL-08", "hr", {
      period: { from: "2026-12-07", to: "2026-12-13" },
    });
    expect(out.shifts).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it("a role with neither schedule permission is forbidden", async () => {
    await expect(
      call("TL-08", "shareholder", { period }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-10 -----------------------------------------------------------------

describe("TL-10 search_sop", () => {
  it("tokenizes safely and builds a snippet around the first match", () => {
    expect(
      sopQueryTokens("Bagaimana cara 'membersihkan' mesin & espresso!? a"),
    ).toEqual(["bagaimana", "cara", "membersihkan", "mesin", "espresso"]);
    expect(
      sopSnippet(
        "x ".repeat(100) + "espresso dibersihkan tiap shift",
        "Judul",
        ["espresso"],
      ),
    ).toContain("espresso");
  });

  it("an employee finds the latest version of a tenant-wide SOP with source and link", async () => {
    const v1 = await seedSop({
      title: "SOP Mesin Espresso",
      body: "Bersihkan mesin espresso setiap tutup shift dengan sabun khusus.",
    });
    const v2 = await seedSop({
      title: "SOP Mesin Espresso",
      body: "Bersihkan mesin espresso setiap shift dengan sabun khusus dan bilas dua kali.",
      version: 2,
      supersedes: v1,
      lineage: v1,
    });
    const out = await call("TL-10", "employee", {
      query: "cara membersihkan mesin espresso",
    });
    expect(out.results.map((r) => r.knowledgeChunkId)).toEqual([v2]);
    expect(out.results[0]).toMatchObject({
      title: "SOP Mesin Espresso",
      sourceVersion: "v2",
      link: `/sop/${v2}`,
    });
    expect(out.results[0].snippet).toContain("espresso");
    expect(out.truncated).toBe(false);
  });

  it("returns nothing when no SOP matches", async () => {
    const out = await call("TL-10", "employee", { query: "zzzxqwv" });
    expect(out.results).toEqual([]);
  });

  it("a station SOP of another outlet is hidden from an employee and an outlet manager but not a wider manager", async () => {
    const id = await seedSop({
      title: "SOP Latte Art Khusus Cabang Dua",
      body: "Prosedur latte art kupuwukapro hanya untuk cabang dua.",
      stationId: stationOutletB,
    });
    const query = { query: "kupuwukapro" };
    expect((await call("TL-10", "employee", query)).results).toEqual([]);
    expect((await call("TL-10", "kitchenLead", query)).results).toEqual([]);
    const wide = await call("TL-10", "generalManager", query);
    expect(wide.results.map((r) => r.knowledgeChunkId)).toEqual([id]);
  });

  it("a manager of outlet A who is an employee of outlet B also finds outlet B station SOPs", async () => {
    const stationB = await seedSop({
      title: "SOP Stasiun Cabang Dua Pegawai",
      body: "Prosedur stasiun duakuwuprokb khusus pegawai cabang dua.",
      stationId: stationOutletB,
    });
    const tenantWide = await seedSop({
      title: "SOP Umum Duakuwuprokb",
      body: "Prosedur umum duakuwuprokb untuk semua cabang.",
    });
    const base = fx.assignments.find((a) => a.userId === fx.users.employee.id);
    if (!base) throw new Error("employee assignment fixture missing");
    const ctx = ctxFor("kitchenLead", [
      roleAssignmentSchema.parse({
        ...base,
        id: randomUUID(),
        userId: fx.users.kitchenLead.id,
        scope: { type: "outlet", id: outletB },
      }),
    ]);
    const handler = readToolsB["TL-10"];
    if (!handler) throw new Error("No handler for TL-10");
    const out = AI_TOOL_IO["TL-10"].output.parse(
      await handler(
        ctx,
        AI_TOOL_IO["TL-10"].input.parse({ query: "duakuwuprokb" }),
      ),
    ) as unknown as ToolOut;
    expect(out.results.map((r) => r.knowledgeChunkId).sort()).toEqual(
      [stationB, tenantWide].sort(),
    );
    // Without the employee assignment the manager (outlet A only) misses it.
    const managerOnly = await call("TL-10", "kitchenLead", {
      query: "duakuwuprokb",
    });
    expect(managerOnly.results.map((r) => r.knowledgeChunkId)).toEqual([
      tenantWide,
    ]);
  });

  it("another tenant's SOP is never returned", async () => {
    const foreignId = await seedSop({
      tenant: otherTenant,
      title: "SOP Rahasia Tenant Lain",
      body: "Prosedur rahasia tenantlain pastikan jangan bocor tenantlain.",
    });
    for (const user of ["owner", "generalManager", "employee"] as const) {
      const out = await call("TL-10", user, { query: "tenantlain rahasia" });
      expect(out.results.map((r) => r.knowledgeChunkId)).not.toContain(
        foreignId,
      );
    }
  });

  it("caps results at the limit and flags truncation", async () => {
    for (let n = 0; n < 3; n += 1)
      await seedSop({
        title: `SOP Kapasitas ${n}`,
        body: "kapasitasuji prosedur harian kapasitasuji.",
      });
    const out = await call("TL-10", "generalManager", {
      query: "kapasitasuji",
      limit: 2,
    });
    expect(out.results).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("a role that can see no SOP is forbidden", async () => {
    await expect(
      call("TL-10", "shareholder", { query: "espresso" }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-11 -----------------------------------------------------------------

describe("TL-11 get_anomalies", () => {
  it("flags a void spike against the previous period, per outlet, with severity", async () => {
    const out = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["void"],
      outletIds: [outletA, outletB],
    });
    // Outlet A: 4 now vs 1 before (x4 -> high). Outlet B: 4 now vs 1 before (x4 -> high).
    expect(
      out.anomalies
        .map((a) => [
          a.outletId,
          a.type,
          a.observedValue,
          a.baselineValue,
          a.severity,
        ])
        .sort(),
    ).toEqual(
      [
        [outletA, "void", "4.0000", "1.0000", "high"],
        [outletB, "void", "4.0000", "1.0000", "high"],
      ].sort(),
    );
    expect(out.anomalies[0].link).toBe("/laporan/anomali");
    expect(out.sources[0]).toMatchObject({
      finality: "estimate",
      period: ANOMALY_PERIOD,
    });
  });

  it("measures discounts and ingredient waste in rupiah", async () => {
    const out = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["discount", "ingredient_usage"],
      outletIds: [outletA],
    });
    const byType = Object.fromEntries(out.anomalies.map((a) => [a.type, a]));
    expect(byType.discount).toMatchObject({
      observedValue: "60000.0000",
      baselineValue: "0.0000",
      severity: "high",
    });
    // 300000 now vs 100000 before: x3 -> medium.
    expect(byType.ingredient_usage).toMatchObject({
      observedValue: "300000.0000",
      baselineValue: "100000.0000",
      severity: "medium",
    });
  });

  it("an outlet manager sees only their outlet and is denied another outlet's filter", async () => {
    const own = await call("TL-11", "outletManager", {
      period: ANOMALY_PERIOD,
      types: ["void"],
    });
    expect(own.anomalies.map((a) => a.outletId)).toEqual([outletA]);
    await expect(
      call("TL-11", "outletManager", {
        period: ANOMALY_PERIOD,
        outletIds: [outletB],
      }),
    ).rejects.toMatchObject(forbidden);
  });

  it("never reports another tenant's events and ignores types it cannot measure", async () => {
    const out = await call("TL-11", "owner", { period: ANOMALY_PERIOD });
    expect(out.anomalies.some((a) => a.outletId === otherOutlet)).toBe(false);
    const cash = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["cash_variance"],
    });
    expect(cash.anomalies).toEqual([]);
  });

  it("does not report a quiet outlet or period", async () => {
    const out = await call("TL-11", "owner", {
      period: { from: "2026-08-01", to: "2026-08-07" },
    });
    expect(out.anomalies).toEqual([]);
  });

  it("a role without report.operational.view is forbidden", async () => {
    await expect(
      call("TL-11", "employee", { period: ANOMALY_PERIOD }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-12 -----------------------------------------------------------------

describe("TL-12 get_my_profit_share", () => {
  const shareholderScope = () => {
    const scope = ctxFor("shareholder").access.contextFor(
      "profit_share.own.view",
      { type: "tenant" },
    );
    if (!scope) throw new Error("shareholder lacks profit_share.own.view");
    return scope;
  };
  const rowsOf = (out: ToolOut) => out.distributions as DistributionRow[];
  /** What the finance service says the shareholder was paid in a year. */
  const serviceStatements = async (year: number) => {
    const mine = await getMyProfitShareService(
      shareholderScope(),
      fx.users.shareholder.id,
      fx.now,
    );
    return mine.distributionHistory.filter((s) =>
      s.period.startsWith(`${year}-`),
    );
  };
  const pairs = (rows: { amount: number; bp: number }[]) =>
    rows.map((r) => `${r.amount}@${r.bp}`).sort();

  it("returns exactly the paid amounts and shares of getMyProfitShareService for the year", async () => {
    const expected = await serviceStatements(2026);
    // Guard against a vacuous test: two paid statements were seeded for 2026.
    expect(expected.map((s) => Number(s.grossIdr)).sort()).toEqual([
      4_500_000, 6_000_000,
    ]);
    const out = await call("TL-12", "shareholder", { year: 2026 });
    const rows = rowsOf(out);
    expect(
      pairs(
        rows.map((r) => ({
          amount: r.amountIdr,
          bp: Math.round(Number(r.sharePct) * 100),
        })),
      ),
    ).toEqual(
      pairs(expected.map((s) => ({ amount: Number(s.netIdr), bp: s.shareBp }))),
    );
    for (const row of rows) {
      expect(row.status).toBe("paid");
      expect(row.periodLabel).toMatch(/2026/);
    }
    expect(out.truncated).toBe(false);
    expect(out.sources[0]).toMatchObject({
      finality: "final",
      period: { from: "2026-01-01", to: "2026-12-31" },
    });
  });

  it("filters by year; the default year is the year of now", async () => {
    const y2025 = rowsOf(await call("TL-12", "shareholder", { year: 2025 }));
    expect(y2025.map((r) => r.amountIdr)).toEqual([3_000_000]);
    const dflt = rowsOf(await call("TL-12", "shareholder", {}));
    expect(dflt.map((r) => r.amountIdr).sort()).toEqual([4_500_000, 6_000_000]);
  });

  it("defaults to the Jakarta year at 03:00 WIB on New Year's Day", async () => {
    const handler = readToolsB["TL-12"];
    if (!handler) throw new Error("No handler for TL-12");
    const ctx = {
      ...ctxFor("shareholder"),
      now: new Date("2025-12-31T20:00:00Z"),
    };
    const output = AI_TOOL_IO["TL-12"].output.parse(await handler(ctx, {}));
    expect(output.sources[0]?.period).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("shows nothing for unpaid lines, unapproved shares, other holders or another tenant", async () => {
    const text = JSON.stringify(
      await call("TL-12", "shareholder", { year: 2026 }),
    );
    // 4,200,000: own line of an approved run that is not paid yet.
    // 2,800,000 / 4,000,000 / 3,000,000: the other shareholder's lines.
    // 9,999,000: the same login's line in another tenant.
    for (const amount of [
      "4200000",
      "2800000",
      "4000000",
      "3000000",
      "9999000",
    ])
      expect(text).not.toMatch(new RegExp(`\\b${amount}\\b`));
    // 33.33%: only in a version that was never approved.
    expect(text).not.toMatch(/33\.33/);
    expect(text).not.toMatch(/Pemegang/);
  });

  it("a shareholder in two entities gets two different labels for the same period", async () => {
    const rows = rowsOf(await call("TL-12", "shareholder", { year: 2027 }));
    expect(rows.map((r) => r.amountIdr).sort()).toEqual([1_000_000, 1_800_000]);
    for (const row of rows)
      expect(row.periodLabel).toMatch(/^Bagi hasil 2027-03 · \S/);
    expect(new Set(rows.map((r) => r.periodLabel)).size).toBe(2);
  });

  it("a year without paid distributions is an empty list with a source", async () => {
    const out = await call("TL-12", "shareholder", { year: 2029 });
    expect(out.distributions).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.sources[0]).toMatchObject({
      period: { from: "2029-01-01", to: "2029-12-31" },
    });
  });

  it("has no shareholder id input: an extra key is rejected by the schema", () => {
    expect(() =>
      AI_TOOL_IO["TL-12"].input.parse({ year: 2026, userId: randomUUID() }),
    ).toThrow();
  });

  it("a non-shareholder is forbidden", async () => {
    await expect(call("TL-12", "owner", {})).rejects.toMatchObject(forbidden);
    await expect(call("TL-12", "employee", {})).rejects.toMatchObject(
      forbidden,
    );
  });
});

// ---- TL-20 -----------------------------------------------------------------

describe("TL-20 get_facility_utilization", () => {
  it("counts sessions, utilization of available minutes and revenue", async () => {
    const out = await call("TL-20", "outletManager", {
      period: PERIOD,
      outletIds: [outletA],
    });
    const row = out.rows.find((r) => r.facilityId === facilityA.id);
    // 3 sessions (2 completed + 1 issued package); holds, cancelled and other days do not count.
    // Booked 180 min of 2 units x 720 min = 1440 -> 12.5000 %.
    expect(row).toMatchObject({
      name: "Read B Shower",
      sessions: 3,
      utilizationPct: "12.5000",
    });
    // 2 purchase tickets x 50000 + 5000 overtime; the package ticket has no price.
    expect(row?.revenueIdr).toBe(105_000);
    expect(out.sources[0]).toMatchObject({
      finality: "estimate",
      link: "/laporan/fasilitas",
    });
  });

  it("filters by facility id", async () => {
    const out = await call("TL-20", "owner", {
      period: PERIOD,
      facilityId: facilityA.id,
    });
    expect(out.rows.map((r) => r.facilityId)).toEqual([facilityA.id]);
  });

  it("an outlet manager is denied an outlet outside their scope", async () => {
    await expect(
      call("TL-20", "outletManager", { period: PERIOD, outletIds: [outletB] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("never returns another tenant's facility, even by id", async () => {
    const foreign = createdFacilities.find((f) => f.tenant === otherTenant)!;
    const all = await call("TL-20", "owner", { period: PERIOD });
    expect(all.rows.some((r) => r.facilityId === foreign.id)).toBe(false);
    const byId = await call("TL-20", "owner", {
      period: PERIOD,
      facilityId: foreign.id,
    });
    expect(byId.rows).toEqual([]);
  });

  it("caps rows at 200 and flags truncation", async () => {
    const out = await call("TL-20", "owner", {
      period: PERIOD,
      outletIds: [outletB],
    });
    expect(out.rows).toHaveLength(TOOL_MAX_ROWS);
    expect(out.truncated).toBe(true);
  });

  it("a role without report.operational.view is forbidden", async () => {
    await expect(
      call("TL-20", "employee", { period: PERIOD }),
    ).rejects.toMatchObject(forbidden);
  });
});
