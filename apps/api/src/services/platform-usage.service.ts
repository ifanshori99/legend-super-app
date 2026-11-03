// Quotas & cost caps, computed and enforced server-side (PRD v1.7 §3 F4
// "Kuota & Plafon", §2 Batasan "Biaya operasional", A17, R18, §6 J
// `usage_costs_daily`).
//
// - Count quotas (outlets, active employees, devices, AI requests per month)
//   and monthly cost caps (WhatsApp, AI, email) are computed from the tenant's
//   own rows inside `withTenant`, so RLS applies on top of the explicit
//   tenant_id filters.
// - The rules themselves (`checkCountQuota`, `evaluateCostCap`, `canSpend`)
//   live in @starter/shared/platform/limits.ts; this module only gathers the
//   numbers and throws the contract errors (QUOTA_EXCEEDED, COST_CAP_REACHED).
// - The month is the Asia/Jakarta calendar month (limits.ts `tenantUsageSchema`).
//
// Sources still owned by later beads are ports with a documented default:
// devices have no registry table yet (0 until WS-02 registers a counter).

import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  COST_CAPS,
  COUNT_QUOTAS,
  PlatformError,
  canSpend,
  checkCountQuota,
  evaluateCostCap,
  tenantUsageSchema,
  tenantUsageViewSchema,
  type CostCap,
  type CountQuota,
  type TenantLimits,
  type TenantUsage,
  type TenantUsageView,
} from "@starter/shared/platform";
import {
  assertTrustedScopedContext,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type * as schema from "../db/schema/index.ts";
import { db } from "../db/index.ts";
import {
  outlets,
  roleAssignments,
  tenants,
  usageCostsDaily,
  type UsageCostComponent,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";

type Database = NodePgDatabase<typeof schema>;
export type UsageTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Head-office time zone for the monthly quota/cost window (limits.ts). */
export const USAGE_TIME_ZONE = "Asia/Jakarta";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Asia/Jakarta calendar day (YYYY-MM-DD) of `now`. */
export function usageDate(now: Date): string {
  return dayFormat.format(now);
}

/** The Asia/Jakarta month of `now` and its [from, to) day range. */
export function usageMonth(now: Date): {
  month: string;
  from: string;
  to: string;
} {
  const [year, month] = usageDate(now).split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    month: `${year}-${pad(month)}`,
    from: `${year}-${pad(month)}-01`,
    to: `${nextYear}-${pad(nextMonth)}-01`,
  };
}

/** Port for a count whose table belongs to a later bead. */
export type UsageCounter = (tx: UsageTx, tenantId: string) => Promise<number>;

const zeroCounter: UsageCounter = async () => 0;
let deviceCounter: UsageCounter = zeroCounter;

/**
 * WS-02 device registry wires the real device count here. Until then the
 * count is 0: no device rows exist to count, and nothing creates one.
 */
export function setDeviceUsageCounter(counter: UsageCounter | null): void {
  deviceCounter = counter ?? zeroCounter;
}

async function countOutlets(tx: UsageTx, tenantId: string): Promise<number> {
  // Same basis as org.service createOutlet: every outlet row counts.
  const [row] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(outlets)
    .where(eq(outlets.tenantId, tenantId));
  return row?.value ?? 0;
}

/**
 * "Karyawan aktif" until the WS-10 employee table exists: distinct users
 * holding a currently valid role assignment in the tenant. Counting more
 * rather than fewer keeps the quota fail-closed.
 */
async function countActiveEmployees(
  tx: UsageTx,
  tenantId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({
      value: sql<number>`count(DISTINCT ${roleAssignments.userId})::int`,
    })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        sql`${roleAssignments.validFrom} <= ${now}`,
        or(
          isNull(roleAssignments.validUntil),
          sql`${roleAssignments.validUntil} > ${now}`,
        ),
      ),
    );
  return row?.value ?? 0;
}

type MonthlyCost = { units: number; costIdr: number };

async function monthlyCosts(
  tx: UsageTx,
  tenantId: string,
  now: Date,
): Promise<Map<UsageCostComponent, MonthlyCost>> {
  const { from, to } = usageMonth(now);
  const rows = await tx
    .select({
      component: usageCostsDaily.component,
      // SUM(bigint) is numeric; the totals stay far below 2^53.
      units: sql<string>`coalesce(sum(${usageCostsDaily.units}), 0)::text`,
      costIdr: sql<string>`coalesce(sum(${usageCostsDaily.costIdr}), 0)::text`,
    })
    .from(usageCostsDaily)
    .where(
      and(
        eq(usageCostsDaily.tenantId, tenantId),
        gte(usageCostsDaily.costDate, from),
        lt(usageCostsDaily.costDate, to),
      ),
    )
    .groupBy(usageCostsDaily.component);
  return new Map(
    rows.map((row) => [
      row.component,
      { units: Number(row.units), costIdr: Number(row.costIdr) },
    ]),
  );
}

/** Current usage of one tenant (must run inside its tenant transaction). */
export async function computeTenantUsage(
  tx: UsageTx,
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantUsage> {
  const [outletCount, activeEmployees, devices, costs] = [
    await countOutlets(tx, tenantId),
    await countActiveEmployees(tx, tenantId, now),
    await deviceCounter(tx, tenantId),
    await monthlyCosts(tx, tenantId, now),
  ];
  const cost = (component: UsageCostComponent) =>
    costs.get(component) ?? { units: 0, costIdr: 0 };
  return tenantUsageSchema.parse({
    month: usageMonth(now).month,
    outlets: outletCount,
    activeEmployees,
    devices,
    aiRequests: cost("ai").units,
    whatsappCostIdr: cost("whatsapp").costIdr,
    aiCostIdr: cost("ai").costIdr,
    emailCostIdr: cost("email").costIdr,
  });
}

async function tenantLimits(
  tx: UsageTx,
  tenantId: string,
): Promise<TenantLimits> {
  const [row] = await tx
    .select({ limits: tenants.limits })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return row.limits;
}

/** Dashboard view: every quota and cost cap with used/remaining. */
export function buildUsageView(
  limits: TenantLimits,
  usage: TenantUsage,
): TenantUsageView {
  return tenantUsageViewSchema.parse({
    usage,
    limits,
    quotas: COUNT_QUOTAS.map((quota) => {
      const { limit, used, remaining } = checkCountQuota(limits, usage, quota);
      return { quota, limit, used, remaining };
    }),
    costCaps: COST_CAPS.map((cap) => ({
      cap,
      ...evaluateCostCap(limits, usage, cap),
    })),
  });
}

async function usageViewIn(
  tx: UsageTx,
  tenantId: string,
  now: Date,
): Promise<TenantUsageView> {
  const limits = await tenantLimits(tx, tenantId);
  return buildUsageView(limits, await computeTenantUsage(tx, tenantId, now));
}

/** GET /api/org/usage: the caller's own tenant (TEN-02). */
export async function getOrgUsage(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<TenantUsageView> {
  return withTenant(db, context, (tx) =>
    usageViewIn(tx, context.tenant.tenantId, now),
  );
}

/**
 * GET /api/platform/tenants/:tenantId/usage. The Super Admin chose the tenant
 * (path parameter, route gated by the platform registry + MFA); the reads
 * still run under that tenant's RLS context. Quota/cost totals are platform
 * billing data, not tenant personal or financial records, so no support
 * access session is required (TEN-04 covers the latter).
 */
export async function getTenantUsageForPlatform(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantUsageView> {
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) => usageViewIn(tx, tenantId, now));
}

// ------------------------------------------------------------- enforcement

/** Serialises quota/cost decisions per tenant for the rest of the tx. */
async function lockTenantUsage(tx: UsageTx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${tenantId}`}, 0))`,
  );
}

/**
 * Refuses the create when `adding` more items would pass the count quota
 * (QUOTA_EXCEEDED). Call inside the same tenant transaction as the insert.
 */
export async function assertCountQuota(
  tx: UsageTx,
  context: ScopedTenantContext,
  quota: CountQuota,
  adding = 1,
  now: Date = new Date(),
): Promise<void> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  await lockTenantUsage(tx, tenantId);
  const limits = await tenantLimits(tx, tenantId);
  const usage = await computeTenantUsage(tx, tenantId, now);
  if (!checkCountQuota(limits, usage, quota, adding).allowed)
    throw new PlatformError("QUOTA_EXCEEDED");
}

/**
 * Refuses spending that would cross the monthly cap (COST_CAP_REACHED). A cap
 * of 0 means the feature is off (PRD §2: WhatsApp replies off by default).
 */
export async function assertCanSpend(
  tx: UsageTx,
  context: ScopedTenantContext,
  cap: CostCap,
  costIdr: Idr,
  now: Date = new Date(),
): Promise<void> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  await lockTenantUsage(tx, tenantId);
  const limits = await tenantLimits(tx, tenantId);
  const usage = await computeTenantUsage(tx, tenantId, now);
  if (!canSpend(limits, usage, cap, costIdr))
    throw new PlatformError("COST_CAP_REACHED");
}

const CAPPED: ReadonlySet<string> = new Set(COST_CAPS);

export type RecordUsageCostInput = {
  readonly component: UsageCostComponent;
  /** Billable units: messages (WhatsApp/email), requests (AI). */
  readonly units: number;
  readonly costIdr: Idr;
  readonly now?: Date;
};

/**
 * Books realised usage into `usage_costs_daily` after the cap and quota
 * checks pass, all under one per-tenant lock so two concurrent sends cannot
 * both slip under the cap. WhatsApp/AI/email are capped (R18); AI units also
 * count against the monthly AI request quota. `gateway`/`server` are recorded
 * only (no cap in the contract).
 */
export async function recordUsageCost(
  context: ScopedTenantContext,
  input: RecordUsageCostInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.units) || input.units < 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Units must be >= 0.");
  if (!Number.isSafeInteger(input.costIdr) || input.costIdr < 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Cost must be >= 0.");
  const now = input.now ?? new Date();
  await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await lockTenantUsage(tx, tenantId);
    const limits = await tenantLimits(tx, tenantId);
    const usage = await computeTenantUsage(tx, tenantId, now);
    if (
      CAPPED.has(input.component) &&
      !canSpend(limits, usage, input.component as CostCap, input.costIdr)
    )
      throw new PlatformError("COST_CAP_REACHED");
    if (
      input.component === "ai" &&
      !checkCountQuota(limits, usage, "ai_requests", input.units).allowed
    )
      throw new PlatformError("QUOTA_EXCEEDED");
    await tx
      .insert(usageCostsDaily)
      .values({
        tenantId,
        costDate: usageDate(now),
        component: input.component,
        units: input.units,
        costIdr: input.costIdr,
      })
      .onConflictDoUpdate({
        target: [
          usageCostsDaily.tenantId,
          usageCostsDaily.costDate,
          usageCostsDaily.component,
        ],
        set: {
          units: sql`${usageCostsDaily.units} + ${input.units}`,
          costIdr: sql`${usageCostsDaily.costIdr} + ${input.costIdr}`,
        },
      });
  });
}
