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
  paymentMethodSchema,
  type PaymentMethod,
} from "@starter/shared/payment";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { paymentRoutingRules } from "../db/schema";
import { withTenant } from "../db/tenant";
import { recordAudit } from "./core-audit";
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
 * PRD §3.13 "Default Legend: seluruh metode online melalui DOIT." Used only
 * when neither the outlet nor the tenant has a stored rule. Non-online methods
 * have no gateway default (they are settled at the counter), so they resolve
 * disabled here and the caller fails closed.
 */
export function defaultRouting(method: PaymentMethod): ResolvedRouting {
  const online = onlinePaymentMethodSchema.safeParse(method).success;
  return online
    ? {
        provider: "doit",
        fallbackProvider: null,
        enabled: true,
        isDefault: true,
      }
    : {
        provider: "manual",
        fallbackProvider: null,
        enabled: false,
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
