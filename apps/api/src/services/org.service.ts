// Tenant organisation services (PRD v1.7 §3 F4 "Hierarki Organisasi", §6 A;
// TEN-02/03/06). Brands, legal entities, outlets and host names of ONE tenant.
//
// Every function takes the server-minted ScopedTenantContext and runs inside
// `withTenant`, so Postgres RLS applies (`app.tenant_id`) on top of the explicit
// tenant_id filters. The tenant is never read from a request body (TEN-02), and
// an outlet-scoped context only reaches its own outlets (TEN-03).
//
// Creating a brand/outlet here is how TEN-06 holds at the tenant level: the
// panel/tenant-admin API writes rows, no deploy.

import { randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import {
  checkCountQuota,
  tenantUsageSchema,
  PlatformError,
  type Brand,
  type CreateBrandInput,
  type CreateLegalEntityInput,
  type CreateOutletInput,
  type FeatureFlags,
  type LegalEntity,
  type Outlet,
  type SetOutletStatusInput,
  type TenantDomain,
  type TenantLimits,
  type TenantUsage,
  type UpdateBrandInput,
  type UpdateLegalEntityInput,
  type UpdateOutletInput,
  type AddDomainInput,
} from "@starter/shared/platform";
import {
  brandSchema,
  legalEntitySchema,
  outletRestoreStatusSchema,
  outletSchema,
  canTransitionOutlet,
  isReservedHostname,
} from "@starter/shared/platform";
import {
  assertOutletInScope,
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import {
  brands,
  itemAvailability,
  legalEntities,
  menuItems,
  outlets,
  tenantDomains,
  tenants,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { provisionStandardChart } from "./accounting-provisioning.service";
import { recordAudit } from "./core-audit";
import { markHppStale } from "./hpp-invalidate";
import {
  provisionOutletStockLocations,
  provisionStandardUoms,
} from "./inventory-provisioning.service";
import { toTenantDomain } from "./org-resolve.service";
import { provisionDefaultServiceChargeRule } from "./tax-provisioning.service";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { assertTenantMedia } from "./tenant-media";
import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
  blindIndexCandidates,
} from "../lib/blind-index";
import { sealSecret } from "../lib/secrets";
import { lockLoyaltyJournalEntity } from "./accounting-auto-journal-amounts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Refuse a change of the program's effective legal entity once loyalty
 * facts or paid work may belong to it. Existing facts lack an entity snapshot. */
async function protectLoyaltyEntityChange(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  change: { add: string } | { outletId: string; entity: string },
): Promise<void> {
  const config = await tx.execute<{ selected: string | null }>(sql`
    SELECT legal_entity_id::text AS selected FROM loyalty_programs WHERE tenant_id = ${tenantId}
  `);
  const rows = await tx.execute<{ id: string; entity: string | null }>(sql`
    SELECT id::text AS id, legal_entity_id::text AS entity FROM outlets WHERE tenant_id = ${tenantId}
  `);
  const configured = config.rows[0]?.selected ?? null;
  const effective = (values: (string | null)[]): string | null => {
    if (configured) return values.includes(configured) ? configured : null;
    const entities = new Set(values);
    return entities.size === 1 ? (values[0] ?? null) : null;
  };
  const previous = rows.rows.map((row) => row.entity);
  const next =
    "add" in change
      ? [...previous, change.add]
      : rows.rows.map((row) =>
          row.id === change.outletId ? change.entity : row.entity,
        );
  const entityChanged = effective(previous) !== effective(next);
  const movingOutlet =
    "outletId" in change &&
    rows.rows.some(
      (row) => row.id === change.outletId && row.entity !== change.entity,
    )
      ? change.outletId
      : null;
  if (!entityChanged && movingOutlet === null) return;

  // AI operations briefly share-lock the tenant. Wait for those operations,
  // but bound the wait; publishers' order/intent locks remain NOWAIT so the
  // organisation change retries instead of blocking payment.
  try {
    await tx.transaction(async (savepoint) => {
      const timeout = await savepoint.execute<{ value: string }>(
        sql`SELECT current_setting('lock_timeout') AS value`,
      );
      await savepoint.execute(sql`SET LOCAL lock_timeout = '1s'`);
      await savepoint.execute(
        sql`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
      );
      await savepoint.execute(
        sql`SELECT set_config('lock_timeout', ${timeout.rows[0]!.value}, true)`,
      );
      await savepoint.execute(
        sql`SELECT id FROM orders WHERE tenant_id = ${tenantId} ORDER BY id FOR SHARE NOWAIT`,
      );
      await savepoint.execute(
        sql`SELECT id FROM payment_intents WHERE tenant_id = ${tenantId} ORDER BY id FOR SHARE NOWAIT`,
      );
    });
  } catch (error) {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 5 && current && typeof current === "object";
      depth += 1
    ) {
      const item = current as { code?: unknown; cause?: unknown };
      if (item.code === "55P03")
        throw new HttpError(
          409,
          "LOYALTY_ENTITY_BUSY",
          "Pembayaran atau poin sedang diproses. Coba ubah outlet lagi.",
        );
      current = item.cause;
    }
    throw error;
  }
  if (!entityChanged && movingOutlet !== null) {
    const affected = await tx.execute<{ has_history: boolean }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM point_ledger WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid) OR
        EXISTS (SELECT 1 FROM point_earn_records WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid) OR
        EXISTS (SELECT 1 FROM loyalty_earn_parked p JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id WHERE p.tenant_id = ${tenantId} AND o.outlet_id = ${movingOutlet}::uuid) OR
        EXISTS (SELECT 1 FROM journal_entries WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid AND source_type = 'loyalty') OR
        EXISTS (SELECT 1 FROM auto_journal_parked WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid AND event_name IN ('points.earned', 'points.reversed', 'points.redeemed', 'points.adjusted', 'points.expired')) OR
        EXISTS (SELECT 1 FROM reward_redemptions WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid) OR
        EXISTS (SELECT 1 FROM loyalty_claim_pauses WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid AND (state IN ('busy', 'ambiguous') OR (state = 'active' AND resume_deadline > now()))) OR
        EXISTS (SELECT 1 FROM domain_event_outbox WHERE tenant_id = ${tenantId} AND outlet_id = ${movingOutlet}::uuid AND destination = 'cloud-sync' AND status <> 'delivered' AND event->>'name' IN ('order.paid', 'payment.paid', 'points.earned', 'points.reversed', 'points.redeemed', 'points.adjusted', 'points.expired')) OR
        EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = ${tenantId} AND o.outlet_id = ${movingOutlet}::uuid AND o.table_session_id IS NOT NULL AND o.customer_profile_id IS NULL AND o.payment_mode = 'pay_first' AND o.status <> 'voided' AND (
          (o.claim_token_hash IS NOT NULL AND o.claim_redeemed_at IS NULL AND o.claim_expires_at > now()) OR
          (o.status IN ('awaiting_payment', 'sent', 'completed') AND o.claim_token_hash IS NULL AND NOT EXISTS (SELECT 1 FROM bill_splits s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id)) OR
          EXISTS (SELECT 1 FROM bill_splits s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id AND (s.status = 'pending' OR (s.status = 'paid' AND s.claim_token_hash IS NULL) OR (s.status = 'paid' AND s.claim_redeemed_at IS NULL AND s.claim_expires_at > now())))
        )) AS has_history
    `);
    if (affected.rows[0]?.has_history !== false)
      throw new HttpError(
        409,
        "LOYALTY_ENTITY_LOCKED",
        "Outlet memiliki riwayat atau klaim poin yang perlu direkonsiliasi.",
      );
    return;
  }
  const history = await tx.execute<{ has_history: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM point_ledger WHERE tenant_id = ${tenantId}) OR
      EXISTS (SELECT 1 FROM point_earn_records WHERE tenant_id = ${tenantId}) OR
      EXISTS (SELECT 1 FROM mission_progress WHERE tenant_id = ${tenantId}) OR
      EXISTS (SELECT 1 FROM reward_redemptions WHERE tenant_id = ${tenantId}) OR
      EXISTS (SELECT 1 FROM vouchers WHERE tenant_id = ${tenantId} AND source = 'loyalty_reward') OR
      EXISTS (SELECT 1 FROM loyalty_earn_parked WHERE tenant_id = ${tenantId}) OR
      EXISTS (SELECT 1 FROM journal_entries WHERE tenant_id = ${tenantId} AND source_type = 'loyalty') OR
      EXISTS (SELECT 1 FROM auto_journal_parked WHERE tenant_id = ${tenantId} AND event_name IN ('points.earned', 'points.reversed', 'points.redeemed', 'points.adjusted', 'points.expired')) OR
      EXISTS (SELECT 1 FROM loyalty_claim_pauses WHERE tenant_id = ${tenantId} AND (state IN ('busy', 'ambiguous') OR (state = 'active' AND resume_deadline > now()))) OR
      EXISTS (SELECT 1 FROM domain_event_outbox WHERE tenant_id = ${tenantId} AND destination = 'cloud-sync' AND status <> 'delivered' AND event->>'name' IN ('order.paid', 'payment.paid', 'points.earned', 'points.reversed', 'points.redeemed', 'points.adjusted', 'points.expired')) OR
      EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = ${tenantId} AND o.table_session_id IS NOT NULL AND o.customer_profile_id IS NULL AND o.payment_mode = 'pay_first' AND o.status <> 'voided' AND (
        (o.claim_token_hash IS NOT NULL AND o.claim_redeemed_at IS NULL AND o.claim_expires_at > now()) OR
        (o.status IN ('awaiting_payment', 'sent', 'completed') AND o.claim_token_hash IS NULL AND NOT EXISTS (SELECT 1 FROM bill_splits s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id)) OR
        EXISTS (SELECT 1 FROM bill_splits s WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id AND
          (s.status = 'pending' OR (s.status = 'paid' AND s.claim_token_hash IS NULL) OR (s.status = 'paid' AND s.claim_redeemed_at IS NULL AND s.claim_expires_at > now())))
      )) AS has_history
  `);
  if (history.rows[0]?.has_history !== false)
    throw new HttpError(
      409,
      "LOYALTY_ENTITY_LOCKED",
      "Entitas poin tidak dapat diubah karena riwayat atau klaim perlu direkonsiliasi.",
    );
}

/** Pause live guest claims whose outlet no longer has a known program entity. */
async function pauseAmbiguousGuestClaims(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
) {
  const selected = sql`COALESCE(
    (SELECT legal_entity_id FROM loyalty_programs WHERE tenant_id = ${tenantId}),
    (SELECT CASE WHEN count(DISTINCT coalesce(legal_entity_id::text, 'NULL')) = 1
                       AND bool_and(legal_entity_id IS NOT NULL)
                 THEN min(legal_entity_id::text)::uuid ELSE NULL END
       FROM outlets WHERE tenant_id = ${tenantId})
  )`;
  const affected = sql`(SELECT id FROM outlets WHERE tenant_id = ${tenantId}
    AND ((${selected}) IS NULL OR legal_entity_id IS DISTINCT FROM (${selected})))`;
  const orderLive = sql`(claim_expires_at > now() OR EXISTS (SELECT 1 FROM loyalty_claim_pauses p WHERE p.tenant_id = orders.tenant_id AND p.order_id = orders.id AND (p.state = 'busy' OR (p.state = 'active' AND p.resume_deadline > now()))))`;
  const splitLive = sql`(claim_expires_at > now() OR EXISTS (SELECT 1 FROM loyalty_claim_pauses p WHERE p.tenant_id = bill_splits.tenant_id AND p.split_id = bill_splits.id AND (p.state = 'busy' OR (p.state = 'active' AND p.resume_deadline > now()))))`;
  try {
    await tx.execute(sql`
      SELECT id FROM orders WHERE tenant_id = ${tenantId} AND outlet_id IN ${affected}
        AND claim_token_hash IS NOT NULL AND claim_redeemed_at IS NULL
        AND ${orderLive} AND status <> 'voided' AND customer_profile_id IS NULL
      ORDER BY id FOR UPDATE NOWAIT
    `);
    await tx.execute(sql`
      SELECT id FROM bill_splits WHERE tenant_id = ${tenantId} AND outlet_id IN ${affected}
        AND claim_token_hash IS NOT NULL AND claim_redeemed_at IS NULL
        AND ${splitLive} AND status = 'paid'
      ORDER BY id FOR UPDATE NOWAIT
    `);
  } catch (error) {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 5 && current && typeof current === "object";
      depth += 1
    ) {
      const item = current as { code?: unknown; cause?: unknown };
      if (item.code === "55P03")
        throw new HttpError(
          409,
          "LOYALTY_ENTITY_BUSY",
          "Klaim sedang diproses. Coba ubah outlet lagi.",
        );
      current = item.cause;
    }
    throw error;
  }
  await tx.execute(sql`
    INSERT INTO loyalty_claim_pauses (tenant_id, outlet_id, order_id, paused_at, remaining_ms, state)
    SELECT orders.tenant_id, orders.outlet_id, orders.id, now(),
      CASE WHEN p.state = 'busy' THEN p.remaining_ms ELSE greatest(1, floor(extract(epoch FROM (coalesce(p.resume_deadline, orders.claim_expires_at) - now())) * 1000)::bigint) END, 'ambiguous'
    FROM orders LEFT JOIN loyalty_claim_pauses p ON p.tenant_id = orders.tenant_id AND p.order_id = orders.id
    WHERE orders.tenant_id = ${tenantId} AND orders.outlet_id IN ${affected}
      AND orders.claim_token_hash IS NOT NULL AND orders.claim_redeemed_at IS NULL
      AND ${orderLive} AND orders.status <> 'voided' AND orders.customer_profile_id IS NULL
    ON CONFLICT (tenant_id, order_id) DO UPDATE SET state = 'ambiguous',
      remaining_ms = EXCLUDED.remaining_ms, resume_deadline = NULL,
      paused_at = CASE WHEN loyalty_claim_pauses.state = 'busy' THEN loyalty_claim_pauses.paused_at ELSE EXCLUDED.paused_at END
      WHERE loyalty_claim_pauses.state IN ('active', 'busy')
  `);
  await tx.execute(sql`
    INSERT INTO loyalty_claim_pauses (tenant_id, outlet_id, split_id, paused_at, remaining_ms, state)
    SELECT bill_splits.tenant_id, bill_splits.outlet_id, bill_splits.id, now(),
      CASE WHEN p.state = 'busy' THEN p.remaining_ms ELSE greatest(1, floor(extract(epoch FROM (coalesce(p.resume_deadline, bill_splits.claim_expires_at) - now())) * 1000)::bigint) END, 'ambiguous'
    FROM bill_splits LEFT JOIN loyalty_claim_pauses p ON p.tenant_id = bill_splits.tenant_id AND p.split_id = bill_splits.id
    WHERE bill_splits.tenant_id = ${tenantId} AND bill_splits.outlet_id IN ${affected}
      AND bill_splits.claim_token_hash IS NOT NULL AND bill_splits.claim_redeemed_at IS NULL
      AND ${splitLive} AND bill_splits.status = 'paid'
    ON CONFLICT (tenant_id, split_id) DO UPDATE SET state = 'ambiguous',
      remaining_ms = EXCLUDED.remaining_ms, resume_deadline = NULL,
      paused_at = CASE WHEN loyalty_claim_pauses.state = 'busy' THEN loyalty_claim_pauses.paused_at ELSE EXCLUDED.paused_at END
      WHERE loyalty_claim_pauses.state IN ('active', 'busy')
  `);
}

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** Unique violation of one named constraint or index. */
function uniqueViolationOn(
  error: unknown,
  constraint: string,
  depth = 0,
): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "23505" && candidate.constraint === constraint) ||
    uniqueViolationOn(candidate.cause, constraint, depth + 1)
  );
}

type DomainRow = typeof tenantDomains.$inferSelect;

function primaryHostname(
  brandId: string,
  domains: Pick<DomainRow, "brandId" | "hostname" | "kind" | "verifiedAt">[],
): string | null {
  const own = domains.filter((domain) => domain.brandId === brandId);
  return (
    own.find((domain) => domain.kind === "platform_subdomain")?.hostname ??
    own.find((domain) => domain.verifiedAt !== null)?.hostname ??
    null
  );
}

function toBrand(
  row: typeof brands.$inferSelect,
  domains: Pick<DomainRow, "brandId" | "hostname" | "kind" | "verifiedAt">[],
): Brand {
  return brandSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    logoMediaId: row.logoMediaId,
    themeId: row.themeId,
    primaryHostname: primaryHostname(row.id, domains),
    createdAt: row.createdAt.toISOString(),
  });
}

export function toOutlet(row: typeof outlets.$inferSelect): Outlet {
  return outletSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    legalEntityId: row.legalEntityId,
    code: row.code,
    name: row.name,
    address: row.address,
    regionId: row.regionId,
    geofence: row.geofence,
    timeZone: row.timezone,
    businessDayCutoff: row.businessDayCutoff,
    openingHours: row.openingHours,
    edgeNodeId: row.edgeNodeId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

function toLegalEntity(row: typeof legalEntities.$inferSelect): LegalEntity {
  return legalEntitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    npwpLast4: row.npwpLast4,
    isPkp: row.isPkp,
    address: row.address,
    // Bank accounts are the accounting contract's rows keyed by this entity
    // (WS-07 bead); until that table exists a new entity has none.
    bankAccountIds: [],
    createdAt: row.createdAt.toISOString(),
  });
}

/** Explicit tenant filter on top of RLS: tenant_domains is readable for host
 * resolution and must never leak another tenant's rows into a list (TEN-01). */
async function domainsOfTenant(
  tx: Tx,
  tenantId: string,
): Promise<(typeof tenantDomains.$inferSelect)[]> {
  return tx
    .select()
    .from(tenantDomains)
    .where(eq(tenantDomains.tenantId, tenantId));
}

async function tenantLimits(tx: Tx, tenantId: string): Promise<TenantLimits> {
  const [row] = await tx
    .select({ limits: tenants.limits })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return row.limits;
}

async function requireBrand(tx: Tx, brandId: string) {
  const [row] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
  return row;
}

async function requireLegalEntity(tx: Tx, legalEntityId: string) {
  const [row] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(eq(legalEntities.id, legalEntityId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
  return row;
}

// ------------------------------------------------------------------- brands

export async function listBrands(
  context: ScopedTenantContext,
): Promise<{ data: Brand[] }> {
  return withTenant(db, context, async (tx) => {
    const [rows, domains] = await Promise.all([
      tx.select().from(brands).orderBy(asc(brands.name), asc(brands.id)),
      domainsOfTenant(tx, context.tenant.tenantId),
    ]);
    return { data: rows.map((row) => toBrand(row, domains)) };
  });
}

type TenantTx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Body of `createBrand`; runs inside the caller's `withTenant` transaction. */
export async function createBrandInTx(
  tx: TenantTx,
  context: ScopedTenantContext,
  input: CreateBrandInput,
): Promise<Brand> {
  // legend-ja7i7 (TEN-10): the logo must be in this tenant's media library;
  // legend-bkdmc: and it must be a `brand_logo` upload.
  await assertTenantMedia(
    tx,
    context.tenant.tenantId,
    input.logoMediaId,
    "Logo",
    "brand_logo",
  );
  try {
    const [row] = await tx
      .insert(brands)
      .values({
        tenantId: context.tenant.tenantId,
        slug: input.slug,
        name: input.name,
        logoMediaId: input.logoMediaId,
      })
      .returning();
    return toBrand(row, []);
  } catch (error) {
    if (uniqueViolation(error))
      throw new HttpError(409, "CONFLICT", "That brand slug is taken.");
    throw error;
  }
}

export async function createBrand(
  context: ScopedTenantContext,
  input: CreateBrandInput,
): Promise<Brand> {
  return withTenant(db, context, (tx) => createBrandInTx(tx, context, input));
}

export async function updateBrand(
  context: ScopedTenantContext,
  brandId: string,
  input: UpdateBrandInput,
): Promise<Brand> {
  return withTenant(db, context, async (tx) => {
    // legend-ja7i7 (TEN-10), legend-bkdmc: same rule as createBrand; null
    // clears the logo.
    await assertTenantMedia(
      tx,
      context.tenant.tenantId,
      input.logoMediaId,
      "Logo",
      "brand_logo",
    );
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.logoMediaId === undefined
        ? {}
        : { logoMediaId: input.logoMediaId }),
    };
    const domains = await domainsOfTenant(tx, context.tenant.tenantId);
    // An empty patch is a read: return the current row instead of an UPDATE
    // with no columns, which Postgres rejects.
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(brands)
        .where(eq(brands.id, brandId))
        .limit(1);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
      return toBrand(current, domains);
    }
    const [row] = await tx
      .update(brands)
      .set(changes)
      .where(eq(brands.id, brandId))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
    return toBrand(row, domains);
  });
}

// ------------------------------------------------------------ legal entities

export async function listLegalEntities(
  context: ScopedTenantContext,
): Promise<{ data: LegalEntity[] }> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(legalEntities)
      .orderBy(asc(legalEntities.name), asc(legalEntities.id));
    return { data: rows.map(toLegalEntity) };
  });
}

const npwpPurpose = (tenantId: string) => `legal_entity-npwp:${tenantId}`;

function npwpColumns(tenantId: string, npwp: string | null) {
  if (npwp === null)
    return {
      npwpEncrypted: null,
      npwpLast4: null,
      npwpHash: null,
      npwpHashVersion: BLIND_INDEX_ACTIVE_VERSION,
    };
  return {
    npwpEncrypted: sealSecret(npwp, `legal_entity:${tenantId}`),
    npwpLast4: npwp.slice(-4),
    npwpHash: blindIndexAt(
      BLIND_INDEX_ACTIVE_VERSION,
      npwp,
      npwpPurpose(tenantId),
    ),
    npwpHashVersion: BLIND_INDEX_ACTIVE_VERSION,
  };
}

const npwpTaken = () =>
  new HttpError(
    409,
    "CONFLICT",
    "That NPWP is already registered for another legal entity.",
  );

/**
 * The unique index is (tenant, digest), so the same NPWP under blind-index
 * version 1 and 2 would not collide (legend-n039). Take the tenant's
 * blind-index lock (also taken by worker/blind-index-rebuild.job.ts), then
 * refuse an NPWP that any other entity holds under any supported version.
 */
async function assertNpwpFree(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  npwp: string | null,
  ownId: string | null,
): Promise<void> {
  if (npwp === null) return;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blind-index:${tenantId}`}, 0))`,
  );
  const digests = blindIndexCandidates(npwp, npwpPurpose(tenantId)).map(
    (candidate) => candidate.digest,
  );
  const [hit] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(
      and(
        eq(legalEntities.tenantId, tenantId),
        inArray(legalEntities.npwpHash, digests),
        ...(ownId === null ? [] : [ne(legalEntities.id, ownId)]),
      ),
    )
    .limit(1);
  if (hit) throw npwpTaken();
}

/** Body of `createLegalEntity`; runs inside the caller's `withTenant` transaction. */
export async function createLegalEntityInTx(
  tx: TenantTx,
  context: ScopedTenantContext,
  input: CreateLegalEntityInput,
): Promise<LegalEntity> {
  const id = randomUUID();
  await assertNpwpFree(tx, context.tenant.tenantId, input.npwp, null);
  let inserted: typeof legalEntities.$inferSelect;
  try {
    const [row] = await tx
      .insert(legalEntities)
      .values({
        id,
        tenantId: context.tenant.tenantId,
        name: input.name,
        ...npwpColumns(context.tenant.tenantId, input.npwp),
        isPkp: input.isPkp,
        address: input.address,
      })
      .returning();
    inserted = row;
  } catch (error) {
    if (uniqueViolation(error)) throw npwpTaken();
    throw error;
  }
  // Outside the NPWP catch, same transaction: a provisioning failure rolls
  // the entity back instead of being read as a duplicate NPWP (PRD v1.7
  // §3.19, legend-a7x7).
  await provisionStandardChart(tx, context, inserted.id, null);
  return toLegalEntity(inserted);
}

export async function createLegalEntity(
  context: ScopedTenantContext,
  input: CreateLegalEntityInput,
): Promise<LegalEntity> {
  return withTenant(db, context, (tx) =>
    createLegalEntityInTx(tx, context, input),
  );
}

export async function updateLegalEntity(
  context: ScopedTenantContext,
  legalEntityId: string,
  input: UpdateLegalEntityInput,
): Promise<LegalEntity> {
  return withTenant(db, context, async (tx) => {
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.npwp === undefined
        ? {}
        : npwpColumns(context.tenant.tenantId, input.npwp)),
      ...(input.isPkp === undefined ? {} : { isPkp: input.isPkp }),
      ...(input.address === undefined ? {} : { address: input.address }),
    };
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(legalEntities)
        .where(eq(legalEntities.id, legalEntityId))
        .limit(1);
      if (!current)
        throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
      return toLegalEntity(current);
    }
    if (input.npwp !== undefined)
      await assertNpwpFree(
        tx,
        context.tenant.tenantId,
        input.npwp,
        legalEntityId,
      );
    try {
      const [row] = await tx
        .update(legalEntities)
        .set(changes)
        .where(eq(legalEntities.id, legalEntityId))
        .returning();
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
      return toLegalEntity(row);
    } catch (error) {
      if (uniqueViolation(error)) throw npwpTaken();
      throw error;
    }
  });
}

// ------------------------------------------------------------------ outlets

function outletScopeFilter(context: ScopedTenantContext): SQL | undefined {
  return context.outletScope.kind === "tenant"
    ? undefined
    : inArray(outlets.id, context.outletScope.outletIds);
}

export async function listOutlets(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string; brandId?: string },
): Promise<{
  data: Outlet[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [];
    const scope = outletScopeFilter(context);
    if (scope) filters.push(scope);
    if (query.brandId) filters.push(eq(outlets.brandId, query.brandId));
    if (query.cursor) {
      const [code, id] = decodeCursor(query.cursor);
      if (typeof code !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const cursorFilter = or(
        gt(outlets.code, code),
        and(eq(outlets.code, code), gt(outlets.id, id)),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(outlets)
      .where(and(...filters))
      .orderBy(asc(outlets.code), asc(outlets.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toOutlet),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.code, last.id])
            : null,
      },
    };
  });
}

/** The outlet being changed must be inside the caller's outlet scope (TEN-03). */
function assertOutletWritable(
  context: ScopedTenantContext,
  outletId: string,
): void {
  if (context.outletScope.kind === "tenant") return;
  assertOutletInScope(context.outletScope, outletId);
}

/**
 * Body of `createOutlet`; runs inside the caller's `withTenant` transaction.
 * Needs a whole-tenant outlet scope and enforces the outlet quota.
 */
export async function createOutletInTx(
  tx: TenantTx,
  context: ScopedTenantContext,
  input: CreateOutletInput,
  actorUserId: string | null,
): Promise<Outlet> {
  if (context.outletScope.kind !== "tenant")
    throw new HttpError(
      403,
      "PERMISSION_DENIED",
      "Pembuatan outlet membutuhkan akses seluruh tenant.",
    );
  await lockLoyaltyJournalEntity(tx, context.tenant.tenantId);
  await protectLoyaltyEntityChange(tx, context.tenant.tenantId, {
    add: input.legalEntityId,
  });
  await requireBrand(tx, input.brandId);
  await requireLegalEntity(tx, input.legalEntityId);
  let inserted: typeof outlets.$inferSelect;
  const [count] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(outlets);
  const limits = await tenantLimits(tx, context.tenant.tenantId);
  // Only the outlet count is needed here; employee/device/AI usage comes
  // with their own tables (WS-10, WS-02, WS-12).
  const usage: TenantUsage = tenantUsageSchema.parse({
    month: new Date().toISOString().slice(0, 7),
    outlets: count?.value ?? 0,
    activeEmployees: 0,
    devices: 0,
    aiRequests: 0,
    whatsappCostIdr: 0,
    aiCostIdr: 0,
    emailCostIdr: 0,
  });
  if (!checkCountQuota(limits, usage, "outlets").allowed)
    throw new PlatformError("QUOTA_EXCEEDED");
  try {
    const [row] = await tx
      .insert(outlets)
      .values({
        tenantId: context.tenant.tenantId,
        brandId: input.brandId,
        legalEntityId: input.legalEntityId,
        code: input.code,
        name: input.name,
        address: input.address,
        regionId: input.regionId,
        geofence: input.geofence,
        timezone: input.timeZone,
        businessDayCutoff: input.businessDayCutoff,
        openingHours: input.openingHours,
      })
      .returning();
    inserted = row;
    // legend-2nb9: a new outlet starts with an availability row for every
    // existing item of its brand, so its 86 screen lists them on day one
    // (the item-create path seeds only the outlets that exist then).
    const items = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.tenantId, context.tenant.tenantId),
          eq(menuItems.brandId, input.brandId),
          isNull(menuItems.deletedAt),
        ),
      );
    if (items.length > 0) {
      const now = new Date();
      await tx
        .insert(itemAvailability)
        .values(
          items.map((item) => ({
            tenantId: context.tenant.tenantId,
            outletId: row.id,
            menuItemId: item.id,
            schedule: [],
            status: "available" as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing();
    }
  } catch (error) {
    if (uniqueViolation(error))
      throw new HttpError(409, "CONFLICT", "That outlet code is taken.");
    throw error;
  }
  // Same transaction (PRD v1.7 §3.19, §16 Lokasi Stok, legend-4ryw): older
  // tenants without UOMs get them here too; both calls are idempotent.
  await provisionStandardUoms(tx, context, null);
  await provisionOutletStockLocations(tx, context, inserted.id, null);
  await pauseAmbiguousGuestClaims(tx, context.tenant.tenantId);
  // A new outlet has no menu_costs rows yet: the next job tick rebuilds it.
  await markHppStale(tx, {
    tenantId: context.tenant.tenantId,
    outletId: inserted.id,
  });
  // Default 5% dine-in service charge for this outlet only (legend-2qz7, Q25).
  const actor = userIdSchema.safeParse(actorUserId);
  await provisionDefaultServiceChargeRule(
    tx,
    context,
    actor.success ? actor.data : null,
    outletIdSchema.parse(inserted.id),
  );
  return toOutlet(inserted);
}

export async function createOutlet(
  context: ScopedTenantContext,
  input: CreateOutletInput,
  actorUserId: string | null = null,
): Promise<Outlet> {
  return withTenant(db, context, (tx) =>
    createOutletInTx(tx, context, input, actorUserId),
  );
}

export async function updateOutlet(
  context: ScopedTenantContext,
  outletId: string,
  input: UpdateOutletInput,
  actorUserId: string,
): Promise<Outlet> {
  assertOutletWritable(context, outletId);
  if (
    input.legalEntityId !== undefined &&
    context.outletScope.kind !== "tenant"
  )
    throw new HttpError(
      403,
      "PERMISSION_DENIED",
      "Perubahan entitas outlet membutuhkan akses seluruh tenant.",
    );
  return withTenant(db, context, async (tx) => {
    if (input.legalEntityId !== undefined) {
      await lockLoyaltyJournalEntity(tx, context.tenant.tenantId);
      await protectLoyaltyEntityChange(tx, context.tenant.tenantId, {
        outletId,
        entity: input.legalEntityId,
      });
    }
    if (input.legalEntityId !== undefined)
      await requireLegalEntity(tx, input.legalEntityId);
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.legalEntityId === undefined
        ? {}
        : { legalEntityId: input.legalEntityId }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
      ...(input.geofence === undefined ? {} : { geofence: input.geofence }),
      ...(input.businessDayCutoff === undefined
        ? {}
        : { businessDayCutoff: input.businessDayCutoff }),
      ...(input.openingHours === undefined
        ? {}
        : { openingHours: input.openingHours }),
    };
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(outlets)
        .where(eq(outlets.id, outletId))
        .limit(1);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      return toOutlet(current);
    }
    const [before] = await tx
      .select({ businessDayCutoff: outlets.businessDayCutoff })
      .from(outlets)
      .where(eq(outlets.id, outletId))
      .limit(1)
      .for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    const [row] = await tx
      .update(outlets)
      .set(changes)
      .where(eq(outlets.id, outletId))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    if (input.legalEntityId !== undefined)
      await pauseAmbiguousGuestClaims(tx, context.tenant.tenantId);
    // Owner Q39: moving the cutoff moves which business date future trade
    // lands on (daily limits, tax and sales reports), so the change is audited.
    if (before.businessDayCutoff !== row.businessDayCutoff)
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(),
          tenantId: context.tenant.tenantId,
          outletId: row.id,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "outlet.business_day_cutoff.updated",
          objectType: "outlet",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: { businessDayCutoff: before.businessDayCutoff },
            after: { businessDayCutoff: row.businessDayCutoff },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: new Date().toISOString(),
        },
        ["businessDayCutoff"],
      );
    return toOutlet(row);
  });
}

export async function setOutletStatus(
  context: ScopedTenantContext,
  outletId: string,
  input: SetOutletStatusInput,
): Promise<Outlet> {
  assertOutletWritable(context, outletId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(outlets)
      .where(eq(outlets.id, outletId))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    if (current.status === input.status) return toOutlet(current);
    if (!canTransitionOutlet(current.status, input.status))
      throw new PlatformError("INVALID_TRANSITION");
    // Q40 (legend-umzos): closing starts the 30-day platform restore window.
    const closing =
      input.status === "closed"
        ? {
            closedAt: new Date(),
            statusBeforeClose: outletRestoreStatusSchema.parse(current.status),
          }
        : {};
    const [row] = await tx
      .update(outlets)
      .set({ status: input.status, ...closing })
      .where(eq(outlets.id, outletId))
      .returning();
    return toOutlet(row);
  });
}

// ------------------------------------------------------------------ domains

export async function listDomains(
  context: ScopedTenantContext,
): Promise<{ data: TenantDomain[] }> {
  return withTenant(db, context, async (tx) => {
    const rows = await domainsOfTenant(tx, context.tenant.tenantId);
    return {
      data: rows
        .sort((a, b) => a.hostname.localeCompare(b.hostname))
        .map(toTenantDomain),
    };
  });
}

export async function addDomain(
  context: ScopedTenantContext,
  input: AddDomainInput,
): Promise<TenantDomain> {
  if (isReservedHostname(input.hostname, env.reservedDomains))
    throw new PlatformError("DOMAIN_RESERVED");
  return withTenant(db, context, async (tx) => {
    await requireBrand(tx, input.brandId);
    try {
      const [row] = await tx
        .insert(tenantDomains)
        .values({
          tenantId: context.tenant.tenantId,
          brandId: input.brandId,
          hostname: input.hostname,
          kind: "custom",
          verificationToken: randomBytes(32).toString("hex"),
        })
        .returning();
      return toTenantDomain(row);
    } catch (error) {
      if (uniqueViolationOn(error, "tenant_domains_tenant_hostname_key"))
        throw new PlatformError("DOMAIN_TAKEN");
      throw error;
    }
  });
}

/** Reads the TXT records at a name; each record is its chunk list. */
export type DomainTxtResolver = (name: string) => Promise<string[][]>;

let txtResolver: DomainTxtResolver = resolveTxt;

/** Test seam: replace the DNS lookup; `null` restores the real resolver. */
export function setDomainTxtResolver(resolver: DomainTxtResolver | null): void {
  txtResolver = resolver ?? resolveTxt;
}

/** True when a TXT record at the verification name carries the exact value.
 * Any lookup failure (ENODATA, ENOTFOUND, ESERVFAIL, timeout) is "not proven". */
async function txtProvesOwnership(record: {
  name: string;
  value: string;
}): Promise<boolean> {
  try {
    const records = await txtResolver(record.name);
    return records.some((chunks) => chunks.join("") === record.value);
  } catch {
    return false;
  }
}

export async function verifyDomain(
  context: ScopedTenantContext,
  domainId: string,
): Promise<TenantDomain> {
  // Reads through the caller's own transaction, so the race path below never
  // asks the pool for a second connection while holding one.
  const loadIn = async (tx: Tx) => {
    const [row] = await tx
      .select()
      .from(tenantDomains)
      .where(
        and(
          eq(tenantDomains.id, domainId),
          eq(tenantDomains.tenantId, context.tenant.tenantId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
    return row;
  };
  const current = await withTenant(db, context, loadIn);
  if (current.verifiedAt !== null) return toTenantDomain(current);
  const record = toTenantDomain(current).verification;
  // The lookup runs outside the transaction: DNS can be slow.
  if (record === null || !(await txtProvesOwnership(record)))
    throw new PlatformError("DOMAIN_VERIFICATION_FAILED");
  return withTenant(db, context, async (tx) => {
    try {
      const [row] = await tx
        .update(tenantDomains)
        .set({ verifiedAt: sql`now()` })
        .where(
          and(
            eq(tenantDomains.id, domainId),
            eq(tenantDomains.tenantId, context.tenant.tenantId),
            isNull(tenantDomains.verifiedAt),
          ),
        )
        .returning();
      // Verified by a concurrent request in the meantime: return it as is.
      return toTenantDomain(row ?? (await loadIn(tx)));
    } catch (error) {
      if (uniqueViolationOn(error, "tenant_domains_verified_hostname_key"))
        throw new PlatformError("DOMAIN_TAKEN");
      throw error;
    }
  });
}

export async function removeDomain(
  context: ScopedTenantContext,
  domainId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .delete(tenantDomains)
      .where(
        and(
          eq(tenantDomains.id, domainId),
          eq(tenantDomains.tenantId, context.tenant.tenantId),
        ),
      )
      .returning({ id: tenantDomains.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
  });
}

/** Tenant feature flags for the panel's module list (read-only). */
export async function getFeatureFlags(
  context: ScopedTenantContext,
): Promise<FeatureFlags> {
  const [row] = await db
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return row.featureFlags;
}
