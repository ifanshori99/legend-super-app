// Default tax configuration per tenant (PRD v1.7 D13 + §3.14 Opsi Perhitungan;
// bead legend-9obf, founder decision Q13 9 Nov 2026: menu prices are NOT nett,
// so the default is exclusive: tax and service are added on the bill).
//
// Values come from `cafeLegendTaxFixtures` so the dev seed and production
// defaults cannot drift: PBJT-FNB 10% tenant-wide, prices exclusive, half_up
// rounding, fixed_bp package allocation. No service-charge rule is seeded: the
// fixture's only one is outlet-scoped (Private Room) and the owner decides.
//
// Rules that live here:
// - Runs inside the caller's tenant transaction, so rows commit or roll back
//   together with the tenant that asked for them.
// - Defaults are data: published version 1 rows the owner replaces by
//   publishing a newer version through the normal tax routes.
// - Idempotent and additive: a tenant that already has any tax rule (or any tax
//   settings) is left exactly as it is for that table; nothing is updated.
//   Serialised per tenant by an advisory lock, so two provisioning runs cannot
//   both see the tenant as empty. Tax routes do not take this lock.
// - `effectiveFrom` is a fixed floor (Perda Kota Bandung 1/2024), not the
//   fixture's date: fixtures are illustrative test data, and a later date would
//   make older business dates fail closed with TAX_RULE_NOT_FOUND.
// - `regionCode` is null on purpose: POS and QR pricing pass no region (outlets
//   carry no PBJT region code yet), so a region-bound rule would never match
//   and every order would fail closed with TAX_RULE_NOT_FOUND.
// - One audit row per call that inserted something; none otherwise.

import { and, eq, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendTaxFixtures } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { taxRules, taxSettings } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import type { TenantTransaction } from "./accounting-shared.ts";
import { recordAudit } from "./core-audit.ts";

/**
 * `published_by` is NOT NULL for a published row. Provisioning without a human
 * actor (backfill) is attributed to this reserved id; the column has no foreign
 * key, so it never needs an account.
 */
export const TAX_PROVISIONING_SYSTEM_USER =
  "00000000-0000-4000-8000-000000000001" as UserId;

/** Audit field names kept unmasked: codes and numbers, no free text. */
const AUDIT_SAFE_FIELDS = [
  "ruleCodes",
  "rateBp",
  "pricesIncludeTax",
  "serviceRoundingMode",
  "taxRoundingMode",
  "packageAllocation",
  "effectiveFrom",
  "version",
] as const;

/** First business date the default configuration covers. */
export const DEFAULT_EFFECTIVE_FROM = "2024-01-01" as BusinessDate;

const DEFAULT_RULE = (() => {
  const rule = cafeLegendTaxFixtures.taxRules.find(
    (row) =>
      row.code === "PBJT-FNB" && row.version === 1 && row.outletId === null,
  );
  if (!rule) throw new Error("cafeLegendTaxFixtures lost its PBJT-FNB v1 rule");
  return rule;
})();

const DEFAULT_SETTINGS = (() => {
  const row = cafeLegendTaxFixtures.settings.find(
    (settings) => settings.outletId === null && settings.version === 1,
  );
  if (!row)
    throw new Error("cafeLegendTaxFixtures lost its tenant-wide tax settings");
  return row;
})();

async function auditProvisioning(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
  input: {
    action: string;
    objectType: string;
    after: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: actorId === null ? "system" : "user",
      actorId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: context.tenant.tenantId,
      reason: null,
      maskedChanges: { before: null, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: new Date().toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/**
 * Adds the default PBJT rule and tax settings this tenant lacks. Existing tax
 * configuration, however old or edited, is never touched.
 */
export async function provisionDefaultTaxConfig(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
): Promise<{ rulesInserted: number; settingsInserted: number }> {
  const tenantId = context.tenant.tenantId;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tax:provisioning:${tenantId}`}, 0))`,
  );
  const publishedBy = actorId ?? TAX_PROVISIONING_SYSTEM_USER;
  const publishedAt = new Date();

  const [existingRule] = await tx
    .select({ id: taxRules.id })
    .from(taxRules)
    .where(eq(taxRules.tenantId, tenantId))
    .limit(1);
  let rulesInserted = 0;
  if (!existingRule) {
    await tx.insert(taxRules).values({
      tenantId,
      outletId: null,
      code: DEFAULT_RULE.code,
      name: DEFAULT_RULE.name,
      taxType: DEFAULT_RULE.taxType,
      rateBp: DEFAULT_RULE.rateBp,
      regionCode: null,
      channels: DEFAULT_RULE.channels,
      appliesTo: DEFAULT_RULE.appliesTo,
      priceIncludesTax: DEFAULT_RULE.priceIncludesTax,
      includeServiceInBase: DEFAULT_RULE.includeServiceInBase,
      isActive: true,
      version: 1,
      effectiveFrom: DEFAULT_EFFECTIVE_FROM,
      status: "published",
      publishedAt,
      publishedBy,
    });
    rulesInserted = 1;
    await auditProvisioning(tx, context, actorId, {
      action: "tax.rules.provisioned",
      objectType: "tax_rule_defaults",
      after: {
        ruleCodes: [DEFAULT_RULE.code],
        rateBp: DEFAULT_RULE.rateBp,
        effectiveFrom: DEFAULT_EFFECTIVE_FROM,
        version: 1,
      },
    });
  }

  const [existingSettings] = await tx
    .select({ id: taxSettings.id })
    .from(taxSettings)
    .where(eq(taxSettings.tenantId, tenantId))
    .limit(1);
  let settingsInserted = 0;
  if (!existingSettings) {
    await tx.insert(taxSettings).values({
      tenantId,
      outletId: null,
      calculationOrder: DEFAULT_SETTINGS.calculationOrder,
      pricesIncludeTax: DEFAULT_SETTINGS.pricesIncludeTax,
      serviceRoundingMode: DEFAULT_SETTINGS.serviceRoundingMode,
      taxRoundingMode: DEFAULT_SETTINGS.taxRoundingMode,
      inclusiveBaseRoundingMode: DEFAULT_SETTINGS.inclusiveBaseRoundingMode,
      billRounding: DEFAULT_SETTINGS.billRounding
        ? {
            incrementIdr: idr(DEFAULT_SETTINGS.billRounding.incrementIdr),
            mode: DEFAULT_SETTINGS.billRounding.mode,
          }
        : null,
      packageAllocation: DEFAULT_SETTINGS.packageAllocation,
      version: 1,
      effectiveFrom: DEFAULT_EFFECTIVE_FROM,
      status: "published",
      publishedAt,
      publishedBy,
    });
    settingsInserted = 1;
    await auditProvisioning(tx, context, actorId, {
      action: "tax.settings.provisioned",
      objectType: "tax_settings_defaults",
      after: {
        pricesIncludeTax: DEFAULT_SETTINGS.pricesIncludeTax,
        serviceRoundingMode: DEFAULT_SETTINGS.serviceRoundingMode,
        taxRoundingMode: DEFAULT_SETTINGS.taxRoundingMode,
        packageAllocation: DEFAULT_SETTINGS.packageAllocation,
        effectiveFrom: DEFAULT_EFFECTIVE_FROM,
        version: 1,
      },
    });
  }
  return { rulesInserted, settingsInserted };
}

/** Tenant-wide context for a backfill; the id comes from the operator script. */
function backfillScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/**
 * Fills the default tax configuration for one existing tenant. `priceReady`
 * is false when the tenant still cannot price an order afterwards (no
 * published, active, tenant-wide rule or no tenant-wide settings: e.g. only
 * draft or outlet-scoped config). The backfill reports it and changes nothing.
 */
export async function backfillTenantTaxDefaults(tenantId: string): Promise<{
  rulesInserted: number;
  settingsInserted: number;
  priceReady: boolean;
}> {
  const context = backfillScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const inserted = await provisionDefaultTaxConfig(tx, context, null);
    const [rule] = await tx
      .select({ id: taxRules.id })
      .from(taxRules)
      .where(
        and(
          eq(taxRules.tenantId, context.tenant.tenantId),
          sql`${taxRules.outletId} IS NULL`,
          eq(taxRules.status, "published"),
          eq(taxRules.isActive, true),
        ),
      )
      .limit(1);
    const [settings] = await tx
      .select({ id: taxSettings.id })
      .from(taxSettings)
      .where(
        and(
          eq(taxSettings.tenantId, context.tenant.tenantId),
          sql`${taxSettings.outletId} IS NULL`,
          eq(taxSettings.status, "published"),
        ),
      )
      .limit(1);
    return { ...inserted, priceReady: Boolean(rule && settings) };
  });
}
