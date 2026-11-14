// Versioned tax and service-charge configuration, the server-side calculation
// preview, the PBJT monthly recap and the per-sale snapshot port
// (PRD v1.7 §3 item 14 F11/F14, §6.C `tax_rules` / `service_charge_rules`,
// D13; bead legend-559).
//
// Every function runs inside `withTenant`, so Postgres RLS scopes rows to the
// resolved tenant (TEN-01/02) and the service re-checks the caller's
// permission on the target — tenant-wide rows need a tenant-level grant, an
// outlet version needs one on that outlet (TEN-03) — on top of the route
// middleware. Rules and prices are data, never code: the calculation itself is
// the shared pure engine (`calculateTax`), the same one QR, POS, website and
// facility call, so a preview can never disagree with a bill.
//
// Published versions are immutable (R21): edits are refused, a change is a new
// version, and publishing appends a domain event through the transactional
// outbox plus an audit row in the same transaction. Past sales are corrected by
// adjustment journals, never by rewriting a rule.

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode, AccessTarget } from "@starter/shared/access";
import {
  assertTrustedScopedContext,
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  isOutletInScope,
  outletIdSchema,
  userIdSchema,
  z,
  type BusinessDate,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  TaxError,
  archiveRuleVersion,
  calculateTax,
  createServiceChargeRuleInputSchema,
  effectiveRuleVersions,
  findTaxRuleTies,
  itemTaxClassLabelId,
  createTaxRuleInputSchema,
  createTaxSettingsInputSchema,
  pbjtMonthlyRecapSchema,
  publishRuleVersion,
  resolveServiceChargeRule,
  serviceChargeRuleIdSchema,
  serviceChargeRulePublished,
  serviceChargeRuleSchema,
  taxRuleIdSchema,
  taxRulePublished,
  taxChannelLabelId,
  taxChannelSchema,
  taxRuleTieScopeLabelId,
  taxRuleSchema,
  taxSettingsIdSchema,
  taxSettingsPublished,
  taxSettingsSchema,
  updateServiceChargeRuleInputSchema,
  updateTaxRuleInputSchema,
  updateTaxSettingsInputSchema,
  type PbjtMonthlyRecap,
  type ServiceChargeRule,
  type TaxCalculationInput,
  type TaxSettingsId,
  type TaxCalculationResult,
  type TaxRuleConflict,
  type TaxRuleId,
  type TaxRuleTie,
  type TaxRule,
  type TaxSettings,
  type TaxType,
} from "@starter/shared/tax";

import { db } from "../db";
import {
  domainEventOutbox,
  outlets,
  serviceChargeRules,
  taxRules,
  taxSettings,
  taxSnapshots,
} from "../db/schema";
import { outletBusinessDayClock } from "./outlet-clock";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { lockServiceChargeConfig, lockTaxConfig } from "./tenant-config-locks";
import { appendOutbox } from "./core-outbox";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";

// The contract's write shapes, so the service accepts exactly what its routes
// validated (clientInputSchema refuses tenant fields at runtime).
type CreateTaxRuleInput = z.output<typeof createTaxRuleInputSchema>;
type UpdateTaxRuleInput = z.output<typeof updateTaxRuleInputSchema>;
type CreateServiceChargeRuleInput = z.output<
  typeof createServiceChargeRuleInputSchema
>;
type UpdateServiceChargeRuleInput = z.output<
  typeof updateServiceChargeRuleInputSchema
>;
type CreateTaxSettingsInput = z.output<typeof createTaxSettingsInputSchema>;
type UpdateTaxSettingsInput = z.output<typeof updateTaxSettingsInputSchema>;

/** Configuration is tenant administration (tenant_admin/admin templates);
 * the report is finance (accounting.tax_report.manage). */
const CONFIG_PERMISSION: PermissionCode = "org.tax_config.manage";
const REPORT_PERMISSION: PermissionCode = "accounting.tax_report.manage";
/** Edge nodes receive published configuration through the cloud-sync stream. */
const EVENT_DESTINATION = "cloud-sync";

type TaxRuleRow = typeof taxRules.$inferSelect;
type ServiceChargeRuleRow = typeof serviceChargeRules.$inferSelect;
type TaxSettingsRow = typeof taxSettings.$inferSelect;
type OutletRow = typeof outlets.$inferSelect;

export type CursorQuery = { limit: number; cursor?: string };
export type RuleListQuery = CursorQuery & {
  outletId?: OutletId;
  status?: TaxRuleRow["status"];
  code?: string;
};

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toTaxRule(row: TaxRuleRow): TaxRule {
  return taxRuleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    code: row.code,
    name: row.name,
    taxType: row.taxType,
    rateBp: row.rateBp,
    regionCode: row.regionCode,
    channels: row.channels,
    appliesTo: row.appliesTo,
    priceIncludesTax: row.priceIncludesTax,
    includeServiceInBase: row.includeServiceInBase,
    isActive: row.isActive,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });
}

function toServiceChargeRule(row: ServiceChargeRuleRow): ServiceChargeRule {
  return serviceChargeRuleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    code: row.code,
    name: row.name,
    rateBp: row.rateBp,
    zoneId: row.zoneId,
    orderTypes: row.orderTypes,
    itemClasses: row.itemClasses,
    isActive: row.isActive,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });
}

function toTaxSettings(row: TaxSettingsRow): TaxSettings {
  return taxSettingsSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    calculationOrder: row.calculationOrder,
    pricesIncludeTax: row.pricesIncludeTax,
    serviceRoundingMode: row.serviceRoundingMode,
    taxRoundingMode: row.taxRoundingMode,
    inclusiveBaseRoundingMode: row.inclusiveBaseRoundingMode,
    billRounding: row.billRounding,
    packageAllocation: row.packageAllocation,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });
}

/** The target a row belongs to: tenant-wide administration or one outlet. */
function targetOf(outletId: string | null): AccessTarget {
  return outletId === null
    ? { type: "tenant" }
    : { type: "outlet", id: outletId };
}

/**
 * Service-layer authorization (TEN-03): the route middleware already answered
 * "may this session call this route"; this answers "may it touch this target",
 * from the assignments stored in the same tenant, inside the tenant
 * transaction. A brand- or outlet-scoped grant never reaches a tenant-wide rule.
 */
async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  target: AccessTarget,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!snapshot.allows(permission, target))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this tenant.",
    );
}

/** The outlet must exist in this tenant and be inside the caller's reach. */
async function requireOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletRow> {
  const id = outletIdSchema.parse(outletId);
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(eq(outlets.id, id), eq(outlets.tenantId, context.tenant.tenantId)),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  if (!isOutletInScope(context.outletScope, row.id))
    throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return row;
}

/** Publishing may not start a version before the outlet's current date (R21). */
async function businessToday(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string | null,
  now: Date,
): Promise<BusinessDate> {
  // A tenant-wide version has no single outlet: the default clock (Jakarta,
  // 04:00) bounds it; an outlet version uses that outlet's clock (owner Q39).
  if (outletId === null) return businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
  const outlet = await requireOutlet(tx, context, outletId);
  return businessDateOf(now, outletBusinessDayClock(outlet));
}

async function nextAggregateSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

type DomainEventLike = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

/** Append one catalogued tax event inside the caller's transaction. */
async function appendTaxEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: DomainEventLike,
  input: {
    aggregateId: string;
    outletId: string | null;
    actorUserId: UserId;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    now: Date;
  },
): Promise<void> {
  const sequence = await nextAggregateSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: input.idempotencyKey.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * `pricesIncludeTax` default for a new rule created without the flag: the
 * calculation setting in force for that outlet on the rule's effective date,
 * else the tenant-wide one, else exclusive — the owner decision of 2026-11-01
 * (menu prices exclude tax and service charge; checkout adds both).
 */
async function defaultPriceIncludesTax(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId | null,
  effectiveFrom: BusinessDate,
): Promise<boolean> {
  const rows = await tx
    .select()
    .from(taxSettings)
    .where(
      and(
        eq(taxSettings.tenantId, context.tenant.tenantId),
        eq(taxSettings.status, "published"),
        or(
          isNull(taxSettings.outletId),
          outletId === null
            ? isNull(taxSettings.outletId)
            : eq(taxSettings.outletId, outletId),
        ),
        sql`${taxSettings.effectiveFrom} <= ${effectiveFrom}`,
      ),
    )
    .orderBy(desc(taxSettings.effectiveFrom), desc(taxSettings.version));
  const outletRow =
    outletId === null
      ? undefined
      : rows.find((row) => row.outletId === outletId);
  const tenantRow = rows.find((row) => row.outletId === null);
  return (outletRow ?? tenantRow)?.pricesIncludeTax ?? false;
}

/** Keyset page over a versioned table ordered by (effectiveFrom, id) desc. */
function versionCursorFilter(
  effectiveFrom: AnyColumn,
  id: AnyColumn,
  cursor: string,
): SQL {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    // A tampered or truncated cursor is a client input error, not a crash.
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [date, lastId] = keys;
  if (typeof date !== "string" || typeof lastId !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return or(
    lt(effectiveFrom, date),
    and(eq(effectiveFrom, date), lt(id, lastId)),
  ) as SQL;
}

// ------------------------------------------------------------------ tax rules

export async function listTaxRules(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RuleListQuery,
): Promise<{
  data: TaxRule[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CONFIG_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [eq(taxRules.tenantId, context.tenant.tenantId)];
    if (query.outletId) {
      filters.push(
        or(
          eq(taxRules.outletId, query.outletId),
          isNull(taxRules.outletId),
        ) as SQL,
      );
    }
    if (context.outletScope.kind !== "tenant")
      filters.push(
        or(
          isNull(taxRules.outletId),
          inArray(taxRules.outletId, [...context.outletScope.outletIds]),
        ) as SQL,
      );
    if (query.status) filters.push(eq(taxRules.status, query.status));
    if (query.code) filters.push(eq(taxRules.code, query.code));
    if (query.cursor)
      filters.push(
        versionCursorFilter(taxRules.effectiveFrom, taxRules.id, query.cursor),
      );
    const rows = await tx
      .select()
      .from(taxRules)
      .where(and(...filters))
      .orderBy(desc(taxRules.effectiveFrom), desc(taxRules.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toTaxRule),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.effectiveFrom, last.id])
            : null,
      },
    };
  });
}

export async function createTaxRule(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateTaxRuleInput,
): Promise<TaxRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(input.outletId),
    );
    await lockTaxConfig(tx, context.tenant.tenantId);
    if (input.outletId) await requireOutlet(tx, context, input.outletId);
    const [latest] = await tx
      .select({ version: taxRules.version })
      .from(taxRules)
      .where(
        and(
          eq(taxRules.tenantId, context.tenant.tenantId),
          input.outletId === null
            ? isNull(taxRules.outletId)
            : eq(taxRules.outletId, input.outletId),
          eq(taxRules.code, input.code),
        ),
      )
      .orderBy(desc(taxRules.version))
      .limit(1);
    const priceIncludesTax =
      input.priceIncludesTax ??
      (await defaultPriceIncludesTax(
        tx,
        context,
        input.outletId,
        input.effectiveFrom,
      ));
    try {
      const [row] = await tx
        .insert(taxRules)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          code: input.code,
          name: input.name,
          taxType: input.taxType,
          rateBp: input.rateBp,
          regionCode: input.regionCode,
          channels: input.channels,
          appliesTo: input.appliesTo,
          priceIncludesTax,
          includeServiceInBase: input.includeServiceInBase,
          isActive: input.isActive,
          version: (latest?.version ?? 0) + 1,
          effectiveFrom: input.effectiveFrom,
          status: "draft",
          publishedAt: null,
          publishedBy: null,
        })
        .returning();
      if (!row) throw new Error("Insert returned no tax rule");
      return toTaxRule(row);
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "CONFLICT",
          "That rule version already exists. Reload and try again.",
        );
      throw error;
    }
  });
}

async function lockTaxRule(tx: Tx, tenantId: TenantId, taxRuleId: string) {
  const id = taxRuleIdSchema.parse(taxRuleId);
  const [row] = await tx
    .select()
    .from(taxRules)
    .where(and(eq(taxRules.id, id), eq(taxRules.tenantId, tenantId)))
    .limit(1)
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tax rule not found.");
  return row;
}

export async function updateTaxRule(
  context: ScopedTenantContext,
  actorUserId: string,
  taxRuleId: string,
  input: UpdateTaxRuleInput,
): Promise<TaxRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxRuleIdSchema.parse(taxRuleId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const row = await lockTaxRule(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.outletId) await requireOutlet(tx, context, row.outletId);
    // Published and archived versions are immutable (R21).
    if (row.status !== "draft") throw new TaxError("TAX_RULE_IMMUTABLE");
    const [updated] = await tx
      .update(taxRules)
      .set({
        name: input.name ?? row.name,
        taxType: input.taxType ?? row.taxType,
        rateBp: input.rateBp ?? row.rateBp,
        regionCode:
          input.regionCode === undefined ? row.regionCode : input.regionCode,
        channels: input.channels ?? row.channels,
        appliesTo: input.appliesTo ?? row.appliesTo,
        priceIncludesTax: input.priceIncludesTax ?? row.priceIncludesTax,
        includeServiceInBase:
          input.includeServiceInBase ?? row.includeServiceInBase,
        isActive: input.isActive ?? row.isActive,
        effectiveFrom: input.effectiveFrom ?? row.effectiveFrom,
      })
      .where(
        and(
          eq(taxRules.id, id),
          eq(taxRules.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated) throw new HttpError(404, "NOT_FOUND", "Tax rule not found.");
    return toTaxRule(updated);
  });
}

/**
 * Discards a draft tax rule version (draft -> archived). The lifecycle refuses
 * a published version (TAX_RULE_IMMUTABLE) and an archived one
 * (TAX_INVALID_TRANSITION): published history is never rewritten (R21).
 */
export async function archiveTaxRule(
  context: ScopedTenantContext,
  actorUserId: string,
  taxRuleId: string,
  now = new Date(),
): Promise<TaxRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxRuleIdSchema.parse(taxRuleId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const row = await lockTaxRule(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.outletId) await requireOutlet(tx, context, row.outletId);
    const archived = archiveRuleVersion({
      status: row.status,
      effectiveFrom: row.effectiveFrom,
      publishedAt: iso(row.publishedAt),
      publishedBy: row.publishedBy,
    });
    const [updated] = await tx
      .update(taxRules)
      .set({ status: archived.status })
      .where(
        and(
          eq(taxRules.id, id),
          eq(taxRules.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated) throw new HttpError(404, "NOT_FOUND", "Tax rule not found.");
    await recordAudit(tx, context, {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "tax_rule.archived",
      objectType: "tax_rule",
      objectId: updated.id,
      reason: null,
      maskedChanges: {
        before: { status: row.status },
        after: {
          code: updated.code,
          version: updated.version,
          status: updated.status,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    return toTaxRule(updated);
  });
}

/**
 * Refuses to publish a tax-rule version that would tie, in `resolveTaxRule`,
 * with another rule in force: the engine then throws TAX_RULE_AMBIGUOUS on every
 * matching line and checkout stops (legend-de3b, mirrors legend-mdh0). Uses the
 * engine's own resolver through `findTaxRuleTies`. Called inside the publish
 * transaction, after the row is marked published and under the per-tenant tax
 * lock. A version with `isActive` false never ties: to replace a rule, publish
 * an inactive version of the old one first.
 */
async function assertNoTaxRuleOverlap(
  tx: Tx,
  tenantId: TenantId,
  published: TaxRuleRow,
): Promise<void> {
  if (!published.isActive) return;
  const rows = await tx
    .select()
    .from(taxRules)
    .where(
      and(
        eq(taxRules.tenantId, tenantId),
        eq(taxRules.status, "published"),
        published.outletId === null
          ? isNull(taxRules.outletId)
          : or(
              isNull(taxRules.outletId),
              eq(taxRules.outletId, published.outletId),
            ),
      ),
    )
    .orderBy(asc(taxRules.version));
  const [tie] = findTaxRuleTies(rows.map(toTaxRule), {
    outletIds: [published.outletId as OutletId | null],
    from: published.effectiveFrom as BusinessDate,
    onlyRuleId: published.id,
  });
  if (!tie) return;
  const mine = tie.a.id === published.id ? tie.a : tie.b;
  const peer = tie.a.id === published.id ? tie.b : tie.a;
  throw new TaxError(
    "TAX_RULE_AMBIGUOUS",
    `Aturan pajak ${mine.code} bertabrakan dengan aturan aktif ${peer.code} v${peer.version} mulai ${tie.effectiveDate} untuk pesanan ${taxChannelLabelId(tie.channel)} (${taxRuleTieScopeLabelId(tie.level, tie.key)}): keduanya berlaku sama kuat dan kasir akan gagal menghitung. Matikan aturan lama dulu (terbitkan versi tidak aktif) atau ubah cakupan aturan ini.`,
  );
}

function toTaxRuleConflict(tie: TaxRuleTie): TaxRuleConflict {
  const side = (rule: TaxRule) => ({
    id: rule.id,
    code: rule.code,
    version: rule.version,
    outletId: rule.outletId,
  });
  return {
    ruleA: side(tie.a),
    ruleB: side(tie.b),
    outletId: tie.outletId,
    channel: tie.channel,
    regionCode: tie.regionCode,
    level: tie.level,
    key: tie.key,
    effectiveDate: tie.effectiveDate,
  };
}

/**
 * Existing published ties (e.g. created before the publish guard): listed for
 * the owner to fix, never changed automatically. Views: tenant-wide plus each
 * outlet that has outlet-scoped rules (or just `query.outletId` and tenant-wide).
 */
export async function listTaxRuleConflicts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { outletId?: OutletId },
): Promise<{ conflicts: TaxRuleConflict[] }> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CONFIG_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [
      eq(taxRules.tenantId, context.tenant.tenantId),
      eq(taxRules.status, "published"),
    ];
    if (context.outletScope.kind !== "tenant")
      filters.push(
        or(
          isNull(taxRules.outletId),
          inArray(taxRules.outletId, [...context.outletScope.outletIds]),
        ) as SQL,
      );
    const rows = await tx
      .select()
      .from(taxRules)
      .where(and(...filters))
      .orderBy(asc(taxRules.version));
    const rules = rows.map(toTaxRule);
    const outletIds: (OutletId | null)[] = query.outletId
      ? [null, query.outletId]
      : [
          null,
          ...new Set(
            rules.flatMap((rule) => (rule.outletId ? [rule.outletId] : [])),
          ),
        ];
    // `from` is the business day of each view, the same helper publish uses.
    const now = new Date();
    const seen = new Set<string>();
    const conflicts: TaxRuleConflict[] = [];
    for (const outletId of outletIds) {
      const from = await businessToday(tx, context, outletId, now);
      for (const tie of findTaxRuleTies(rules, {
        outletIds: [outletId],
        from,
      })) {
        const pair = [tie.a.id, tie.b.id].sort().join("|");
        if (seen.has(pair)) continue;
        seen.add(pair);
        conflicts.push(toTaxRuleConflict(tie));
      }
    }
    return { conflicts };
  });
}

export async function publishTaxRule(
  context: ScopedTenantContext,
  actorUserId: string,
  taxRuleId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<TaxRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxRuleIdSchema.parse(taxRuleId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const row = await lockTaxRule(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    // Publishing is idempotent: a retry of a published version returns it
    // instead of appending a second event (the request carries an
    // idempotencyKey for exactly this).
    if (row.status === "published") return toTaxRule(row);
    const today = await businessToday(tx, context, row.outletId, now);
    const published = publishRuleVersion(
      {
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        publishedAt: iso(row.publishedAt),
        publishedBy: row.publishedBy,
      },
      { today, actorId: actor, at: now.toISOString() },
    );
    const [updated] = await tx
      .update(taxRules)
      .set({
        status: published.status,
        publishedAt: new Date(published.publishedAt ?? now.toISOString()),
        publishedBy: published.publishedBy,
      })
      .where(
        and(
          eq(taxRules.id, id),
          eq(taxRules.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated) throw new HttpError(404, "NOT_FOUND", "Tax rule not found.");
    // Throws inside the transaction: the publish above rolls back.
    await assertNoTaxRuleOverlap(tx, context.tenant.tenantId, updated);
    await appendTaxEvent(tx, context, taxRulePublished, {
      aggregateId: updated.id,
      outletId: updated.outletId,
      actorUserId: actor,
      idempotencyKey: `${taxRulePublished.name}:${updated.id}:${updated.version}:${idempotencyKey}`,
      now,
      payload: {
        taxRuleId: updated.id,
        code: updated.code,
        rateBp: updated.rateBp,
        isActive: updated.isActive,
        outletId: updated.outletId,
        version: updated.version,
        effectiveFrom: updated.effectiveFrom,
      },
    });
    await recordAudit(tx, context, {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "tax_rule.published",
      objectType: "tax_rule",
      objectId: updated.id,
      reason: null,
      maskedChanges: {
        before: { status: row.status },
        after: {
          code: updated.code,
          rateBp: updated.rateBp,
          isActive: updated.isActive,
          version: updated.version,
          effectiveFrom: updated.effectiveFrom,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    return toTaxRule(updated);
  });
}

// --------------------------------------------------- service-charge rules

export async function listServiceChargeRules(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RuleListQuery,
): Promise<{
  data: ServiceChargeRule[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CONFIG_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [
      eq(serviceChargeRules.tenantId, context.tenant.tenantId),
    ];
    if (query.outletId) {
      filters.push(
        or(
          eq(serviceChargeRules.outletId, query.outletId),
          isNull(serviceChargeRules.outletId),
        ) as SQL,
      );
    }
    if (context.outletScope.kind !== "tenant")
      filters.push(
        or(
          isNull(serviceChargeRules.outletId),
          inArray(serviceChargeRules.outletId, [
            ...context.outletScope.outletIds,
          ]),
        ) as SQL,
      );
    if (query.status) filters.push(eq(serviceChargeRules.status, query.status));
    if (query.code) filters.push(eq(serviceChargeRules.code, query.code));
    if (query.cursor)
      filters.push(
        versionCursorFilter(
          serviceChargeRules.effectiveFrom,
          serviceChargeRules.id,
          query.cursor,
        ),
      );
    const rows = await tx
      .select()
      .from(serviceChargeRules)
      .where(and(...filters))
      .orderBy(
        desc(serviceChargeRules.effectiveFrom),
        desc(serviceChargeRules.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toServiceChargeRule),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.effectiveFrom, last.id])
            : null,
      },
    };
  });
}

export async function createServiceChargeRule(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateServiceChargeRuleInput,
): Promise<ServiceChargeRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(input.outletId),
    );
    if (input.outletId) await requireOutlet(tx, context, input.outletId);
    // Same lock as the default-rule seed (legend-mdh0).
    await lockServiceChargeConfig(tx, context.tenant.tenantId);
    const [latest] = await tx
      .select({ version: serviceChargeRules.version })
      .from(serviceChargeRules)
      .where(
        and(
          eq(serviceChargeRules.tenantId, context.tenant.tenantId),
          input.outletId === null
            ? isNull(serviceChargeRules.outletId)
            : eq(serviceChargeRules.outletId, input.outletId),
          eq(serviceChargeRules.code, input.code),
        ),
      )
      .orderBy(desc(serviceChargeRules.version))
      .limit(1);
    try {
      const [row] = await tx
        .insert(serviceChargeRules)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          code: input.code,
          name: input.name,
          rateBp: input.rateBp,
          zoneId: input.zoneId,
          orderTypes: input.orderTypes,
          itemClasses: input.itemClasses,
          isActive: input.isActive,
          version: (latest?.version ?? 0) + 1,
          effectiveFrom: input.effectiveFrom,
          status: "draft",
          publishedAt: null,
          publishedBy: null,
        })
        .returning();
      if (!row) throw new Error("Insert returned no service-charge rule");
      return toServiceChargeRule(row);
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "CONFLICT",
          "That rule version already exists. Reload and try again.",
        );
      throw error;
    }
  });
}

async function lockServiceChargeRule(
  tx: Tx,
  tenantId: TenantId,
  serviceChargeRuleId: string,
) {
  const id = serviceChargeRuleIdSchema.parse(serviceChargeRuleId);
  const [row] = await tx
    .select()
    .from(serviceChargeRules)
    .where(
      and(
        eq(serviceChargeRules.id, id),
        eq(serviceChargeRules.tenantId, tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row)
    throw new HttpError(404, "NOT_FOUND", "Service-charge rule not found.");
  return row;
}

export async function updateServiceChargeRule(
  context: ScopedTenantContext,
  actorUserId: string,
  serviceChargeRuleId: string,
  input: UpdateServiceChargeRuleInput,
): Promise<ServiceChargeRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = serviceChargeRuleIdSchema.parse(serviceChargeRuleId);
    const row = await lockServiceChargeRule(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.outletId) await requireOutlet(tx, context, row.outletId);
    if (row.status !== "draft") throw new TaxError("TAX_RULE_IMMUTABLE");
    const [updated] = await tx
      .update(serviceChargeRules)
      .set({
        name: input.name ?? row.name,
        rateBp: input.rateBp ?? row.rateBp,
        zoneId: input.zoneId === undefined ? row.zoneId : input.zoneId,
        orderTypes: input.orderTypes ?? row.orderTypes,
        itemClasses: input.itemClasses ?? row.itemClasses,
        isActive: input.isActive ?? row.isActive,
        effectiveFrom: input.effectiveFrom ?? row.effectiveFrom,
      })
      .where(
        and(
          eq(serviceChargeRules.id, id),
          eq(serviceChargeRules.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Service-charge rule not found.");
    return toServiceChargeRule(updated);
  });
}

/** Stands in for "any outlet" when the rule being published is tenant-wide. */
const ANY_OUTLET = "00000000-0000-4000-8000-000000000000" as OutletId;

/**
 * Refuses to publish a service-charge version that would tie, in
 * `resolveServiceChargeRule`, with another rule in force: the engine then
 * throws TAX_RULE_AMBIGUOUS on every matching line and checkout stops
 * (legend-mdh0). Uses the engine's own resolver, so the check cannot drift from
 * what a bill does. Called inside the publish transaction, after the row is
 * marked published and under the per-tenant service-charge lock.
 *
 * A version with `isActive` false never ties (it only turns a code off). To
 * replace a rule, publish an inactive version of the old one first.
 * Checked on the new version's start date and on every later date a peer
 * rule starts, so a future-dated rule cannot hide a tie. Compared pair by pair
 * with each rule in force, so no tie can hide under a stronger rule.
 */
async function assertNoServiceChargeOverlap(
  tx: Tx,
  tenantId: TenantId,
  published: ServiceChargeRuleRow,
): Promise<void> {
  if (!published.isActive) return;
  const rows = await tx
    .select()
    .from(serviceChargeRules)
    .where(
      and(
        eq(serviceChargeRules.tenantId, tenantId),
        eq(serviceChargeRules.status, "published"),
        published.outletId === null
          ? isNull(serviceChargeRules.outletId)
          : or(
              isNull(serviceChargeRules.outletId),
              eq(serviceChargeRules.outletId, published.outletId),
            ),
      ),
    )
    .orderBy(asc(serviceChargeRules.version));
  const rules = rows.map(toServiceChargeRule);
  const mine = rules.find((rule) => rule.id === published.id);
  if (!mine) return;
  const outletId = (published.outletId ?? ANY_OUTLET) as OutletId;
  const dates = [
    ...new Set([
      mine.effectiveFrom,
      ...rules
        .map((rule) => rule.effectiveFrom)
        .filter((date) => date > mine.effectiveFrom),
    ]),
  ];
  const zones: (string | null)[] =
    mine.zoneId !== null
      ? [mine.zoneId]
      : [
          null,
          ...new Set(
            rules.flatMap((rule) =>
              rule.zoneId === null ? [] : [rule.zoneId],
            ),
          ),
        ];
  const channels =
    mine.orderTypes.length > 0 ? mine.orderTypes : taxChannelSchema.options;
  for (const date of dates) {
    const inForce = effectiveRuleVersions(rules, outletId, date);
    if (!inForce.some((rule) => rule.id === mine.id)) continue;
    // Pairwise, not against the whole set: a stronger rule that wins in every
    // context would hide a tie between two weaker ones, and the tie would
    // surface at checkout the day that stronger rule is narrowed or turned off.
    for (const peer of inForce) {
      if (peer.id === mine.id) continue;
      for (const zoneId of zones) {
        for (const channel of channels) {
          for (const itemClass of mine.itemClasses) {
            try {
              resolveServiceChargeRule(
                [mine, peer],
                {
                  outletId,
                  channel,
                  zoneId: zoneId as TaxCalculationInput["zoneId"],
                  regionCode: null,
                },
                itemClass,
              );
            } catch (error) {
              if (
                !(error instanceof TaxError) ||
                error.code !== "TAX_RULE_AMBIGUOUS"
              )
                throw error;
              throw new TaxError(
                "TAX_RULE_AMBIGUOUS",
                `Aturan service charge ${mine.code} bertabrakan dengan aturan aktif ${peer.code} untuk pesanan ${taxChannelLabelId(channel)} (${itemTaxClassLabelId(itemClass)}): keduanya berlaku sama kuat dan kasir akan gagal menghitung. Matikan aturan lama dulu (terbitkan versi tidak aktif) atau ubah cakupan aturan ini.`,
              );
            }
          }
        }
      }
    }
  }
}

export async function publishServiceChargeRule(
  context: ScopedTenantContext,
  actorUserId: string,
  serviceChargeRuleId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<ServiceChargeRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = serviceChargeRuleIdSchema.parse(serviceChargeRuleId);
    // Serialises publishes (and the default-rule seed) per tenant, so the
    // overlap check below sees every rule another publish has just committed.
    await lockServiceChargeConfig(tx, context.tenant.tenantId);
    const row = await lockServiceChargeRule(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.status === "published") return toServiceChargeRule(row);
    const today = await businessToday(tx, context, row.outletId, now);
    const published = publishRuleVersion(
      {
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        publishedAt: iso(row.publishedAt),
        publishedBy: row.publishedBy,
      },
      { today, actorId: actor, at: now.toISOString() },
    );
    const [updated] = await tx
      .update(serviceChargeRules)
      .set({
        status: published.status,
        publishedAt: new Date(published.publishedAt ?? now.toISOString()),
        publishedBy: published.publishedBy,
      })
      .where(
        and(
          eq(serviceChargeRules.id, id),
          eq(serviceChargeRules.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Service-charge rule not found.");
    // Throws inside the transaction: the publish above rolls back.
    await assertNoServiceChargeOverlap(tx, context.tenant.tenantId, updated);
    await appendTaxEvent(tx, context, serviceChargeRulePublished, {
      aggregateId: updated.id,
      outletId: updated.outletId,
      actorUserId: actor,
      idempotencyKey: `${serviceChargeRulePublished.name}:${updated.id}:${updated.version}:${idempotencyKey}`,
      now,
      payload: {
        serviceChargeRuleId: updated.id,
        code: updated.code,
        rateBp: updated.rateBp,
        isActive: updated.isActive,
        outletId: updated.outletId,
        version: updated.version,
        effectiveFrom: updated.effectiveFrom,
      },
    });
    await recordAudit(tx, context, {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "service_charge_rule.published",
      objectType: "service_charge_rule",
      objectId: updated.id,
      reason: null,
      maskedChanges: {
        before: { status: row.status },
        after: {
          code: updated.code,
          rateBp: updated.rateBp,
          isActive: updated.isActive,
          version: updated.version,
          effectiveFrom: updated.effectiveFrom,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    return toServiceChargeRule(updated);
  });
}

// -------------------------------------------------------------- tax settings

export async function listTaxSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  query: RuleListQuery,
): Promise<{
  data: TaxSettings[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CONFIG_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [eq(taxSettings.tenantId, context.tenant.tenantId)];
    if (query.outletId) {
      filters.push(
        or(
          eq(taxSettings.outletId, query.outletId),
          isNull(taxSettings.outletId),
        ) as SQL,
      );
    }
    if (context.outletScope.kind !== "tenant")
      filters.push(
        or(
          isNull(taxSettings.outletId),
          inArray(taxSettings.outletId, [...context.outletScope.outletIds]),
        ) as SQL,
      );
    if (query.status) filters.push(eq(taxSettings.status, query.status));
    if (query.cursor)
      filters.push(
        versionCursorFilter(
          taxSettings.effectiveFrom,
          taxSettings.id,
          query.cursor,
        ),
      );
    const rows = await tx
      .select()
      .from(taxSettings)
      .where(and(...filters))
      .orderBy(desc(taxSettings.effectiveFrom), desc(taxSettings.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toTaxSettings),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.effectiveFrom, last.id])
            : null,
      },
    };
  });
}

export async function createTaxSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateTaxSettingsInput,
): Promise<TaxSettings> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(input.outletId),
    );
    await lockTaxConfig(tx, context.tenant.tenantId);
    if (input.outletId) await requireOutlet(tx, context, input.outletId);
    const [latest] = await tx
      .select({ version: taxSettings.version })
      .from(taxSettings)
      .where(
        and(
          eq(taxSettings.tenantId, context.tenant.tenantId),
          input.outletId === null
            ? isNull(taxSettings.outletId)
            : eq(taxSettings.outletId, input.outletId),
        ),
      )
      .orderBy(desc(taxSettings.version))
      .limit(1);
    try {
      const [row] = await tx
        .insert(taxSettings)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          calculationOrder: input.calculationOrder,
          pricesIncludeTax: input.pricesIncludeTax,
          serviceRoundingMode: input.serviceRoundingMode,
          taxRoundingMode: input.taxRoundingMode,
          inclusiveBaseRoundingMode: input.inclusiveBaseRoundingMode,
          billRounding:
            input.billRounding === null
              ? null
              : {
                  incrementIdr: idr(input.billRounding.incrementIdr),
                  mode: input.billRounding.mode,
                },
          packageAllocation: input.packageAllocation,
          version: (latest?.version ?? 0) + 1,
          effectiveFrom: input.effectiveFrom,
          status: "draft",
          publishedAt: null,
          publishedBy: null,
        })
        .returning();
      if (!row) throw new Error("Insert returned no tax settings");
      return toTaxSettings(row);
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "CONFLICT",
          "That settings version already exists. Reload and try again.",
        );
      throw error;
    }
  });
}

async function lockTaxSettings(tx: Tx, tenantId: TenantId, id: TaxSettingsId) {
  const [row] = await tx
    .select()
    .from(taxSettings)
    .where(and(eq(taxSettings.id, id), eq(taxSettings.tenantId, tenantId)))
    .limit(1)
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tax settings not found.");
  return row;
}

/** Edits a settings draft; published and archived versions are immutable. */
export async function updateTaxSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  taxSettingsId: string,
  input: UpdateTaxSettingsInput,
): Promise<TaxSettings> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxSettingsIdSchema.parse(taxSettingsId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const row = await lockTaxSettings(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.outletId) await requireOutlet(tx, context, row.outletId);
    if (row.status !== "draft") throw new TaxError("TAX_RULE_IMMUTABLE");
    const billRounding =
      input.billRounding === undefined
        ? row.billRounding
        : input.billRounding === null
          ? null
          : {
              incrementIdr: idr(input.billRounding.incrementIdr),
              mode: input.billRounding.mode,
            };
    const [updated] = await tx
      .update(taxSettings)
      .set({
        calculationOrder: input.calculationOrder ?? row.calculationOrder,
        pricesIncludeTax: input.pricesIncludeTax ?? row.pricesIncludeTax,
        serviceRoundingMode:
          input.serviceRoundingMode ?? row.serviceRoundingMode,
        taxRoundingMode: input.taxRoundingMode ?? row.taxRoundingMode,
        inclusiveBaseRoundingMode:
          input.inclusiveBaseRoundingMode ?? row.inclusiveBaseRoundingMode,
        billRounding,
        packageAllocation: input.packageAllocation ?? row.packageAllocation,
        effectiveFrom: input.effectiveFrom ?? row.effectiveFrom,
      })
      .where(
        and(
          eq(taxSettings.id, id),
          eq(taxSettings.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Tax settings not found.");
    return toTaxSettings(updated);
  });
}

/** Discards a settings draft (draft -> archived; published is refused). */
export async function archiveTaxSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  taxSettingsId: string,
  now = new Date(),
): Promise<TaxSettings> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxSettingsIdSchema.parse(taxSettingsId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const row = await lockTaxSettings(tx, context.tenant.tenantId, id);
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.outletId) await requireOutlet(tx, context, row.outletId);
    const archived = archiveRuleVersion({
      status: row.status,
      effectiveFrom: row.effectiveFrom,
      publishedAt: iso(row.publishedAt),
      publishedBy: row.publishedBy,
    });
    const [updated] = await tx
      .update(taxSettings)
      .set({ status: archived.status })
      .where(
        and(
          eq(taxSettings.id, id),
          eq(taxSettings.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Tax settings not found.");
    await recordAudit(tx, context, {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "tax_settings.archived",
      objectType: "tax_settings",
      objectId: updated.id,
      reason: null,
      maskedChanges: {
        before: { status: row.status },
        after: { version: updated.version, status: updated.status },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    return toTaxSettings(updated);
  });
}

export async function publishTaxSettings(
  context: ScopedTenantContext,
  actorUserId: string,
  taxSettingsId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<TaxSettings> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const id = taxSettingsIdSchema.parse(taxSettingsId);
    await lockTaxConfig(tx, context.tenant.tenantId);
    const [row] = await tx
      .select()
      .from(taxSettings)
      .where(
        and(
          eq(taxSettings.id, id),
          eq(taxSettings.tenantId, context.tenant.tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new HttpError(404, "NOT_FOUND", "Tax settings not found.");
    await assertPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      targetOf(row.outletId),
    );
    if (row.status === "published") return toTaxSettings(row);
    const today = await businessToday(tx, context, row.outletId, now);
    const published = publishRuleVersion(
      {
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        publishedAt: iso(row.publishedAt),
        publishedBy: row.publishedBy,
      },
      { today, actorId: actor, at: now.toISOString() },
    );
    const [updated] = await tx
      .update(taxSettings)
      .set({
        status: published.status,
        publishedAt: new Date(published.publishedAt ?? now.toISOString()),
        publishedBy: published.publishedBy,
      })
      .where(
        and(
          eq(taxSettings.id, id),
          eq(taxSettings.tenantId, context.tenant.tenantId),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Tax settings not found.");
    await appendTaxEvent(tx, context, taxSettingsPublished, {
      aggregateId: updated.id,
      outletId: updated.outletId,
      actorUserId: actor,
      idempotencyKey: `${taxSettingsPublished.name}:${updated.id}:${updated.version}:${idempotencyKey}`,
      now,
      payload: {
        taxSettingsId: updated.id,
        outletId: updated.outletId,
        version: updated.version,
        effectiveFrom: updated.effectiveFrom,
      },
    });
    await recordAudit(tx, context, {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: updated.outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "tax_settings.published",
      objectType: "tax_settings",
      objectId: updated.id,
      reason: null,
      maskedChanges: {
        before: { status: row.status },
        after: {
          pricesIncludeTax: updated.pricesIncludeTax,
          packageAllocation: updated.packageAllocation,
          version: updated.version,
          effectiveFrom: updated.effectiveFrom,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    return toTaxSettings(updated);
  });
}

// ------------------------------------------------------------- calculation

/**
 * Server-side calculation for the configuration preview (ORD-03: the server's
 * numbers are the only ones that count). The same engine runs for orders,
 * POS, website and facility through `calculateTax`; this endpoint only loads
 * the tenant's published configuration under RLS.
 */
export async function previewTaxCalculation(
  context: ScopedTenantContext,
  actorUserId: string,
  input: TaxCalculationInput,
): Promise<TaxCalculationResult> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CONFIG_PERMISSION, {
      type: "outlet",
      id: input.outletId,
    });
    await requireOutlet(tx, context, input.outletId);
    const [rules, serviceCharge, settings] = await Promise.all([
      tx
        .select()
        .from(taxRules)
        .where(
          and(
            eq(taxRules.tenantId, context.tenant.tenantId),
            eq(taxRules.status, "published"),
            or(
              isNull(taxRules.outletId),
              eq(taxRules.outletId, input.outletId),
            ),
          ),
        )
        .orderBy(asc(taxRules.version)),
      tx
        .select()
        .from(serviceChargeRules)
        .where(
          and(
            eq(serviceChargeRules.tenantId, context.tenant.tenantId),
            eq(serviceChargeRules.status, "published"),
            or(
              isNull(serviceChargeRules.outletId),
              eq(serviceChargeRules.outletId, input.outletId),
            ),
          ),
        )
        .orderBy(asc(serviceChargeRules.version)),
      tx
        .select()
        .from(taxSettings)
        .where(
          and(
            eq(taxSettings.tenantId, context.tenant.tenantId),
            eq(taxSettings.status, "published"),
            or(
              isNull(taxSettings.outletId),
              eq(taxSettings.outletId, input.outletId),
            ),
          ),
        )
        .orderBy(asc(taxSettings.version)),
    ]);
    return calculateTax(input, {
      taxRules: rules.map(toTaxRule),
      serviceChargeRules: serviceCharge.map(toServiceChargeRule),
      settings: settings.map(toTaxSettings),
    });
  });
}

// ------------------------------------------------------------ PBJT recap

/** First day of the period and of the next one, as business dates. */
function periodBounds(period: string): { from: string; toExclusive: string } {
  const [year, month] = period.split("-").map(Number);
  const next =
    month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    from: `${period}-01`,
    toExclusive: `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}-01`,
  };
}

/**
 * Monthly PBJT recap per outlet (§3.14 "Laporan Pajak", D13): one row per
 * (rule code, rate, price mode) actually applied to PBJT sales in the period,
 * from the immutable per-sale snapshots. Inclusive and exclusive sales stay in
 * separate rows because their gross is not on the same basis; tax and tax base
 * are summed exactly. PPN and other tax types are excluded: they are
 * not regional PBJT revenue and have their own report. Gross sales are the
 * menu-priced amounts before discounts; the tax base is the DPP the tax was
 * computed on.
 */
export async function getPbjtMonthlyRecap(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { outletId: string; period: string },
  now = new Date(),
): Promise<PbjtMonthlyRecap> {
  const outletId = outletIdSchema.parse(query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, REPORT_PERMISSION, {
      type: "outlet",
      id: outletId,
    });
    await requireOutlet(tx, context, outletId);
    const { from, toExclusive } = periodBounds(query.period);
    const rows = await tx
      .select({
        taxRuleCode: taxSnapshots.taxRuleCode,
        rateBp: sql<number>`${taxSnapshots.rateBp}::int`,
        priceIncludesTax: taxSnapshots.priceIncludesTax,
        transactionCount: sql<number>`count(DISTINCT (${taxSnapshots.sourceType}, ${taxSnapshots.sourceId}))::int`,
        grossSalesIdr: sql<string>`sum(${taxSnapshots.grossIdr})`,
        taxBaseIdr: sql<string>`sum(${taxSnapshots.taxBaseIdr})`,
        serviceChargeIdr: sql<string>`sum(${taxSnapshots.serviceChargeIdr})`,
        taxIdr: sql<string>`sum(${taxSnapshots.taxIdr})`,
      })
      .from(taxSnapshots)
      .where(
        and(
          eq(taxSnapshots.tenantId, context.tenant.tenantId),
          eq(taxSnapshots.outletId, outletId),
          // PBJT recap only: a PPN or "other" snapshot must never land in the
          // regional tax report (pre-review finding tax.service.ts:1318/1338).
          eq(taxSnapshots.taxType, "pbjt"),
          sql`${taxSnapshots.businessDate} >= ${from}`,
          sql`${taxSnapshots.businessDate} < ${toExclusive}`,
        ),
      )
      .groupBy(
        taxSnapshots.taxRuleCode,
        taxSnapshots.rateBp,
        taxSnapshots.priceIncludesTax,
      )
      .orderBy(
        asc(taxSnapshots.taxRuleCode),
        asc(taxSnapshots.rateBp),
        asc(taxSnapshots.priceIncludesTax),
      );
    const regions = await tx
      .selectDistinct({ regionCode: taxRules.regionCode })
      .from(taxSnapshots)
      .innerJoin(
        taxRules,
        and(
          eq(taxRules.tenantId, taxSnapshots.tenantId),
          eq(taxRules.id, taxSnapshots.taxRuleId),
        ),
      )
      .where(
        and(
          eq(taxSnapshots.tenantId, context.tenant.tenantId),
          eq(taxSnapshots.outletId, outletId),
          // PBJT recap only: a PPN or "other" snapshot must never land in the
          // regional tax report (pre-review finding tax.service.ts:1318/1338).
          eq(taxSnapshots.taxType, "pbjt"),
          sql`${taxSnapshots.businessDate} >= ${from}`,
          sql`${taxSnapshots.businessDate} < ${toExclusive}`,
        ),
      );
    const regionCodes = regions
      .map((row) => row.regionCode)
      .filter((code): code is string => code !== null);
    const recapRows = rows.map((row) => ({
      taxRuleCode: row.taxRuleCode,
      rateBp: Number(row.rateBp),
      priceIncludesTax: row.priceIncludesTax,
      transactionCount: Number(row.transactionCount),
      grossSalesIdr: idr(Number(row.grossSalesIdr)),
      taxBaseIdr: idr(Number(row.taxBaseIdr)),
      serviceChargeIdr: idr(Number(row.serviceChargeIdr)),
      taxIdr: idr(Number(row.taxIdr)),
    }));
    return pbjtMonthlyRecapSchema.parse({
      tenantId: context.tenant.tenantId,
      outletId,
      period: query.period,
      regionCode: regionCodes.length === 1 ? regionCodes[0] : null,
      generatedAt: now.toISOString(),
      rows: recapRows,
      totalTaxBaseIdr: idr(sum(recapRows.map((row) => row.taxBaseIdr))),
      totalTaxIdr: idr(sum(recapRows.map((row) => row.taxIdr))),
    });
  });
}

function sum(values: readonly Idr[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ------------------------------------------------------ sale snapshot port

export type TaxSnapshotSourceType =
  "order" | "pos_sale" | "facility_ticket" | "preorder";

export type TaxSnapshotInput = {
  sourceType: TaxSnapshotSourceType;
  /** Order / POS sale / ticket id (UUID). */
  sourceId: string;
  outletId: string;
  /** Outlet-local business date of the sale. */
  businessDate: BusinessDate;
  /** The server's calculation for that sale (ORD-03). */
  result: TaxCalculationResult;
};

/**
 * Persists the tax parts of one sale for the PBJT recap, inside the sale's own
 * transaction: the caller (WS-04 order checkout, POS, facility) already ran
 * `calculateTax` and stores the same numbers on the bill. One row per rule
 * applied. A re-quote of the same source replaces the whole set (delete then
 * insert) under a source-scoped advisory lock, so rows for rules the new
 * calculation no longer applies cannot survive as obsolete snapshots and two
 * concurrent re-quotes cannot interleave into a mixed set.
 */
export async function recordTaxSnapshots(
  tx: Tx,
  context: ScopedTenantContext,
  input: TaxSnapshotInput,
): Promise<void> {
  assertTrustedScopedContext(context);
  if (!isOutletInScope(context.outletScope, input.outletId))
    throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  const grossByRule = new Map<string, number>();
  const serviceByRule = new Map<string, number>();
  for (const line of input.result.lines) {
    grossByRule.set(
      line.taxRuleId,
      (grossByRule.get(line.taxRuleId) ?? 0) + line.grossIdr,
    );
    serviceByRule.set(
      line.taxRuleId,
      (serviceByRule.get(line.taxRuleId) ?? 0) + line.serviceChargeIdr,
    );
  }
  const rows = input.result.taxes.map((summary) => {
    const grossIdr = grossByRule.get(summary.taxRuleId);
    if (grossIdr === undefined)
      throw new TaxError(
        "TAX_RULE_NOT_FOUND",
        "A calculated tax line has no matching rule group.",
      );
    return {
      taxRuleId: summary.taxRuleId,
      taxRuleCode: summary.code,
      taxRuleVersion: summary.version,
      taxType: summary.taxType,
      rateBp: summary.rateBp,
      priceIncludesTax: summary.priceIncludesTax,
      grossIdr: idr(grossIdr),
      taxBaseIdr: summary.taxBaseIdr,
      serviceChargeIdr: idr(serviceByRule.get(summary.taxRuleId) ?? 0),
      taxIdr: summary.taxIdr,
    };
  });
  await replaceTaxSnapshotRows(tx, context, input, rows);
}

/** One `tax_snapshots` row of a sale, before the sale's keys are added. */
type TaxSnapshotRowValues = {
  taxRuleId: TaxRuleId;
  taxRuleCode: string;
  taxRuleVersion: number;
  taxType: TaxType;
  rateBp: number;
  priceIncludesTax: boolean;
  grossIdr: Idr;
  taxBaseIdr: Idr;
  serviceChargeIdr: Idr;
  taxIdr: Idr;
};

/**
 * Edge sales GL (legend-uctlr): the same snapshot rows as
 * `recordTaxSnapshots`, but copied from the rows the edge already computed
 * (`order.paid` payload `taxes`), never recomputed. Same lock, same
 * replace-the-set semantics, same table.
 */
export async function recordTaxSnapshotsFromPayload(
  tx: Tx,
  context: ScopedTenantContext,
  input: Omit<TaxSnapshotInput, "result"> & {
    taxes: readonly {
      taxRuleId: TaxRuleId;
      code: string;
      version: number;
      taxType: TaxType;
      rateBp: number;
      priceIncludesTax: boolean;
      grossIdr: Idr;
      taxBaseIdr: Idr;
      serviceChargeIdr: Idr;
      taxIdr: Idr;
    }[];
  },
): Promise<void> {
  assertTrustedScopedContext(context);
  if (!isOutletInScope(context.outletScope, input.outletId))
    throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  await replaceTaxSnapshotRows(
    tx,
    context,
    input,
    input.taxes.map((row) => ({
      taxRuleId: row.taxRuleId,
      taxRuleCode: row.code,
      taxRuleVersion: row.version,
      taxType: row.taxType,
      rateBp: row.rateBp,
      priceIncludesTax: row.priceIncludesTax,
      grossIdr: row.grossIdr,
      taxBaseIdr: row.taxBaseIdr,
      serviceChargeIdr: row.serviceChargeIdr,
      taxIdr: row.taxIdr,
    })),
  );
}

/**
 * Shared writer of both entry points: serializes re-quotes of the source,
 * replaces its whole snapshot set. The caller has already checked the scope.
 */
async function replaceTaxSnapshotRows(
  tx: Tx,
  context: ScopedTenantContext,
  input: Omit<TaxSnapshotInput, "result">,
  rows: readonly TaxSnapshotRowValues[],
): Promise<void> {
  // Serialize re-quotes of the same sale for the rest of this transaction.
  // The lock key names the source row, so unrelated bills never contend.
  const lockKey = `${context.tenant.tenantId}:${input.sourceType}:${input.sourceId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  await tx
    .delete(taxSnapshots)
    .where(
      and(
        eq(taxSnapshots.tenantId, context.tenant.tenantId),
        eq(taxSnapshots.sourceType, input.sourceType),
        eq(taxSnapshots.sourceId, input.sourceId),
      ),
    );
  const outletId = outletIdSchema.parse(input.outletId);
  if (rows.length > 0)
    await tx.insert(taxSnapshots).values(
      rows.map((row) => ({
        tenantId: context.tenant.tenantId,
        outletId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        businessDate: input.businessDate,
        ...row,
      })),
    );
}
