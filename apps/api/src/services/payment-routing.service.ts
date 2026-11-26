// Gateway and EDC routing configuration (bead legend-gz3; PRD v1.7 §3.13
// "Routing per Metode").
//
// A rule can be tenant-wide (outlet_id NULL) or override one outlet. Changing
// a rule only affects new intents: nothing rewrites an order, a journal or a
// report (PAY-05). Authorization is `org.settings.manage` over the whole
// tenant, because routing chooses which gateway receives the money; outlet
// cashier defaults (which EDC terminal) stay with `payment.edc.manage`.

import {
  assertOutletInScope,
  createUlid,
  isoDateTimeSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import {
  integrationProviderSchema,
  isIntegrationProviderAvailable,
} from "@starter/shared/platform";
import {
  paymentMethodSchema,
  type PaymentMethod,
} from "@starter/shared/payment";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { paymentRoutingRules, tenantIntegrations, tenants } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import {
  paymentGatewayLegacyMode,
  registeredGatewayProviders,
} from "./payment-gateway";
import {
  isPlatformGatewayEnabled,
  platformDefaultGateway,
} from "./platform-payment-gateway.service";
import { assertPaymentPermission } from "./payment-support";
import type { Tx } from "./permission-resolver";

/** Online methods offered on a guest payment link (PRD "Metode DOIT"). */
export const onlinePaymentMethodSchema = z.enum([
  "qris",
  "va",
  "bank_transfer",
]);
export type OnlinePaymentMethod = z.infer<typeof onlinePaymentMethodSchema>;

export const paymentRoutingRuleInputSchema = z.strictObject({
  /** null sets the tenant default; an outlet row overrides it. */
  outletId: uuidSchema.nullable(),
  method: paymentMethodSchema,
  provider: z.string().min(1).max(20),
  fallbackProvider: z.string().min(1).max(20).nullable(),
  enabled: z.boolean(),
});
export type PaymentRoutingRuleInput = z.input<
  typeof paymentRoutingRuleInputSchema
>;

/** Wire shape. `outletId` null means the rule applies to the whole tenant. */
export type PaymentRoutingRule = {
  readonly id: string;
  readonly tenantId: string;
  readonly outletId: string | null;
  readonly method: PaymentMethod;
  readonly provider: string;
  readonly fallbackProvider: string | null;
  readonly enabled: boolean;
  readonly updatedAt: string;
};

export type ResolvedRouting = {
  readonly provider: string;
  readonly fallbackProvider: string | null;
  readonly enabled: boolean;
  /** True when no stored rule exists and the PRD default applies. */
  readonly isDefault: boolean;
};

type RoutingRow = typeof paymentRoutingRules.$inferSelect;

function toRule(row: RoutingRow): PaymentRoutingRule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    method: row.method,
    provider: row.provider,
    fallbackProvider: row.fallbackProvider,
    enabled: row.enabled,
    updatedAt: isoDateTimeSchema.parse(row.updatedAt.toISOString()),
  };
}

/**
 * No stored rule: online methods go to the platform default gateway
 * (`platformDefaultGateway()`, Super Admin's pick). No default (null) means
 * the method is off, so the caller fails closed (legend-osqou.40). Only the
 * test-only legacy port mode keeps the old PRD §3.13 "DOIT" default. Non-online
 * methods have no gateway default (they are settled at the counter), so they
 * resolve disabled here too.
 */
export async function defaultRouting(
  method: PaymentMethod,
): Promise<ResolvedRouting> {
  const off: ResolvedRouting = {
    provider: "manual",
    fallbackProvider: null,
    enabled: false,
    isDefault: true,
  };
  if (!onlinePaymentMethodSchema.safeParse(method).success) return off;
  const provider = paymentGatewayLegacyMode()
    ? "doit"
    : await platformDefaultGateway();
  if (provider === null) return off;
  return {
    provider,
    fallbackProvider: null,
    enabled: true,
    isDefault: true,
  };
}

/** Outlet override first, then the tenant default, then the PRD default. */
export async function resolveRoutingRule(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  method: PaymentMethod,
): Promise<ResolvedRouting> {
  const rows = await tx
    .select()
    .from(paymentRoutingRules)
    .where(
      and(
        eq(paymentRoutingRules.tenantId, context.tenant.tenantId),
        eq(paymentRoutingRules.method, method),
        or(
          eq(paymentRoutingRules.outletId, outletId),
          isNull(paymentRoutingRules.outletId),
        ),
      ),
    );
  const outletRule = rows.find((row) => row.outletId === outletId);
  const rule = outletRule ?? rows.find((row) => row.outletId === null);
  if (!rule) return defaultRouting(method);
  return {
    provider: rule.provider,
    fallbackProvider: rule.fallbackProvider,
    enabled: rule.enabled,
    isDefault: false,
  };
}

export type ProviderRoutability = {
  /** An adapter is registered in this deployment. */
  readonly registered: boolean;
  /** Super Admin switched the gateway on. */
  readonly platformEnabled: boolean;
  /** The tenant's package lists the gateway (`integrationProviders`). */
  readonly tenantAllowed: boolean;
  /** An active integration row serves this scope. */
  readonly integrated: boolean;
};

/**
 * What stands between a rule and `provider` (sub-302 D12). An outlet rule
 * needs an active outlet row or an active tenant-wide row (the same pick as
 * `resolveIntegration`); a tenant-wide rule needs an active tenant-wide row or
 * at least one active outlet row. Fails closed on unreadable tenant flags.
 */
export async function providerRoutability(
  tx: Tx,
  context: ScopedTenantContext,
  provider: string,
  outletId: string | null,
): Promise<ProviderRoutability> {
  const registered = registeredGatewayProviders().includes(provider);
  const platformEnabled = await isPlatformGatewayEnabled(provider);
  const known = integrationProviderSchema.safeParse(provider);
  const [tenant] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  const tenantAllowed =
    known.success &&
    isIntegrationProviderAvailable(tenant?.featureFlags, known.data);
  // A provider outside the integration catalog can have no integration row.
  if (!known.success)
    return { registered, platformEnabled, tenantAllowed, integrated: false };
  const rows = await tx
    .select({ outletId: tenantIntegrations.outletId })
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, context.tenant.tenantId),
        eq(tenantIntegrations.provider, known.data),
        eq(tenantIntegrations.status, "active"),
      ),
    );
  const wanted = outletId?.toLowerCase() ?? null;
  const integrated = rows.some((row) =>
    wanted === null
      ? true
      : row.outletId === null || row.outletId.toLowerCase() === wanted,
  );
  return { registered, platformEnabled, tenantAllowed, integrated };
}

/**
 * Write-time gate for an ENABLED rule (sub-302 D12): the provider and its
 * fallback must be registered, platform-enabled, allowed for the tenant and
 * backed by an active integration; the fallback must differ from the provider.
 * Tenant-allowed is re-checked at intent time too (payment-gateway-select.ts):
 * a later package change does not rewrite rules (PAY-05).
 */
export async function assertRoutableProvider(
  tx: Tx,
  context: ScopedTenantContext,
  provider: string,
  outletId: string | null,
  fallbackProvider: string | null,
): Promise<void> {
  const refuse = (reason: string): never => {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `GATEWAY_NOT_AVAILABLE: ${reason}`,
    );
  };
  if (fallbackProvider !== null && fallbackProvider === provider)
    refuse("The fallback gateway must differ from the main gateway.");
  for (const candidate of fallbackProvider === null
    ? [provider]
    : [provider, fallbackProvider]) {
    const found = await providerRoutability(tx, context, candidate, outletId);
    if (!found.registered) refuse(`${candidate} has no adapter.`);
    if (!found.platformEnabled) refuse(`${candidate} is switched off.`);
    if (!found.tenantAllowed)
      refuse(`${candidate} is not in this tenant's package.`);
    if (!found.integrated)
      refuse(`${candidate} has no active integration for this scope.`);
  }
}

export async function listRoutingRules(
  context: ScopedTenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<{ data: PaymentRoutingRule[] }> {
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "org.settings.manage",
      { type: "tenant" },
      now,
    );
    const rows = await tx
      .select()
      .from(paymentRoutingRules)
      .where(eq(paymentRoutingRules.tenantId, context.tenant.tenantId))
      .orderBy(
        asc(paymentRoutingRules.method),
        asc(paymentRoutingRules.outletId),
        asc(paymentRoutingRules.id),
      );
    return { data: rows.map(toRule) };
  });
}

/**
 * Creates or replaces the rule for this level and method. Audited in the same
 * transaction: which gateway receives customer money is a controlled change.
 */
export async function upsertRoutingRule(
  context: ScopedTenantContext,
  input: PaymentRoutingRuleInput,
  actorUserId: string,
  now = new Date(),
): Promise<PaymentRoutingRule> {
  const parsed = paymentRoutingRuleInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actorUserId,
      "org.settings.manage",
      { type: "tenant" },
      now,
    );
    if (parsed.outletId)
      assertOutletInScope(context.outletScope, parsed.outletId);
    else if (context.outletScope.kind !== "tenant")
      throw new AccessError(
        "PERMISSION_DENIED",
        "Tenant-wide gateway routing needs a tenant-wide role.",
      );

    if (parsed.enabled)
      await assertRoutableProvider(
        tx,
        context,
        parsed.provider,
        parsed.outletId,
        parsed.fallbackProvider,
      );

    const existingRows = await tx
      .select()
      .from(paymentRoutingRules)
      .where(
        and(
          eq(paymentRoutingRules.tenantId, context.tenant.tenantId),
          eq(paymentRoutingRules.method, parsed.method),
          parsed.outletId === null
            ? isNull(paymentRoutingRules.outletId)
            : eq(paymentRoutingRules.outletId, parsed.outletId),
        ),
      );
    const existing = existingRows[0];
    const values = {
      provider: parsed.provider,
      fallbackProvider: parsed.fallbackProvider,
      enabled: parsed.enabled,
      updatedBy: actorUserId,
      updatedAt: now,
    };
    const [row] = existing
      ? await tx
          .update(paymentRoutingRules)
          .set(values)
          .where(
            and(
              eq(paymentRoutingRules.tenantId, context.tenant.tenantId),
              eq(paymentRoutingRules.id, existing.id),
            ),
          )
          .returning()
      : await tx
          .insert(paymentRoutingRules)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: parsed.outletId,
            method: parsed.method,
            ...values,
          })
          .returning();
    if (!row) throw new Error("Routing rule write returned no row");

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: parsed.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: existing
          ? "payment.routing_updated"
          : "payment.routing_created",
        objectType: "payment_routing_rule",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: existing
            ? {
                method: existing.method,
                provider: existing.provider,
                fallbackProvider: existing.fallbackProvider,
                enabled: existing.enabled,
              }
            : null,
          after: {
            method: row.method,
            provider: row.provider,
            fallbackProvider: row.fallbackProvider,
            enabled: row.enabled,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["method", "provider", "fallbackProvider", "enabled"],
    );
    return toRule(row);
  });
}
