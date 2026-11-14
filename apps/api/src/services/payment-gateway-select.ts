// Provider selection for the gateway registry (sub-302 D4).
//
// A new intent picks its gateway here: the routing rule's provider, then its
// fallback only when the primary is down or disabled on the platform (Q73).
// An existing intent never comes through here: it resolves by its own
// `payment_intents.provider` (PAY-05).

import type { ScopedTenantContext } from "@starter/shared/core";
import {
  integrationProviderSchema,
  isIntegrationProviderAvailable,
  PAYMENT_GATEWAY_PROVIDERS,
} from "@starter/shared/platform";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { tenants } from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  paymentGatewayFor,
  paymentGatewayLegacyMode,
  type GatewayHealth,
  type PaymentGatewayPort,
} from "./payment-gateway";
import {
  resolveRoutingRule,
  type ResolvedRouting,
} from "./payment-routing.service";
import { isPlatformGatewayEnabled } from "./platform-payment-gateway.service";

export type GatewaySelection =
  | {
      readonly provider: string;
      readonly port: PaymentGatewayPort;
      readonly health: GatewayHealth;
    }
  | { readonly provider: null; readonly health: GatewayHealth };

const ONLINE_METHODS = ["qris", "va", "bank_transfer"] as const;

/** Platform "enabled" switch. Legacy test mode (one port for every provider)
 * has no platform rows to read, so it counts as enabled. */
async function platformEnabled(provider: string): Promise<boolean> {
  if (paymentGatewayLegacyMode()) return true;
  return isPlatformGatewayEnabled(provider);
}

function candidatesOf(routing: ResolvedRouting): string[] {
  const list = [routing.provider];
  if (routing.fallbackProvider && routing.fallbackProvider !== routing.provider)
    list.push(routing.fallbackProvider);
  return list;
}

type PackageGate = {
  readonly allows: (provider: string) => boolean;
  /** The package lists at least one payment gateway. */
  readonly listsAnyGateway: boolean;
};

const OPEN_GATE: PackageGate = { allows: () => true, listsAnyGateway: false };

/**
 * Package gate read at selection time (legend-8zy5f): a rule may name a gateway
 * only while the tenant's package (`featureFlags.integrationProviders`) still
 * lists it. The rule write checks this too (D12), but a later package change
 * does not rewrite rules (PAY-05), so the rule is re-checked each time it is
 * used. An unreadable flag set fails closed. Not applied in legacy test mode
 * (one port for every provider).
 */
async function readPackageGate(
  context: ScopedTenantContext,
): Promise<PackageGate> {
  if (paymentGatewayLegacyMode()) return OPEN_GATE;
  const [tenant] = await withTenant(db, context, (tx) =>
    tx
      .select({ featureFlags: tenants.featureFlags })
      .from(tenants)
      .where(eq(tenants.id, context.tenant.tenantId))
      .limit(1),
  );
  const allows = (provider: string): boolean => {
    const known = integrationProviderSchema.safeParse(provider);
    return (
      known.success &&
      isIntegrationProviderAvailable(tenant?.featureFlags, known.data)
    );
  };
  return {
    allows,
    listsAnyGateway: PAYMENT_GATEWAY_PROVIDERS.some(allows),
  };
}

/**
 * Candidates a rule may use now. A stored rule needs every gateway in the
 * package. The PRD default (no stored rule, DOIT) is gated only when the
 * package lists some payment gateway but not that one (a downgrade): a legacy
 * tenant whose package lists no gateway keeps the default (D8, PAY-05).
 */
function allowedCandidates(
  routing: ResolvedRouting,
  gate: PackageGate,
): string[] {
  const list = candidatesOf(routing);
  if (routing.isDefault && !gate.listsAnyGateway) return list;
  return list.filter(gate.allows);
}

const DISABLED_HEALTH: GatewayHealth = { status: "down" };

export async function selectGatewayForNewIntent(
  context: ScopedTenantContext,
  outletId: string,
  routing: ResolvedRouting,
): Promise<GatewaySelection> {
  const candidates = allowedCandidates(routing, await readPackageGate(context));
  let primaryHealth: GatewayHealth | null = null;
  for (const provider of candidates) {
    const port = paymentGatewayFor(provider);
    if (!(await platformEnabled(provider))) {
      primaryHealth ??= DISABLED_HEALTH;
      continue;
    }
    const health = await port.health(context, outletId);
    primaryHealth ??= health;
    // Legacy test mode has one port for every provider: the intent belongs to
    // the provider that port speaks, so its status reads and the QRIS hold
    // closure evidence (D-03) use the right rule.
    if (health.status !== "down")
      return {
        provider: paymentGatewayLegacyMode() ? port.provider : provider,
        port,
        health,
      };
  }
  return { provider: null, health: primaryHealth ?? DISABLED_HEALTH };
}

const RANK: Record<GatewayHealth["status"], number> = {
  available: 2,
  degraded: 1,
  down: 0,
};

/**
 * Health of the outlet's online payments: the best reading among the providers
 * its enabled online rules name (primary and fallback). `down` therefore means
 * no online gateway is usable (cashier failover). `reason: "unconfigured"` only
 * when every reading is down and unconfigured.
 */
export async function outletGatewayHealth(
  context: ScopedTenantContext,
  outletId: string,
): Promise<GatewayHealth & { provider: string }> {
  const routings = await withTenant(db, context, async (tx) => {
    const rules: ResolvedRouting[] = [];
    for (const method of ONLINE_METHODS)
      rules.push(await resolveRoutingRule(tx, context, outletId, method));
    return rules;
  });
  const gate = routings.some((rule) => rule.enabled)
    ? await readPackageGate(context)
    : OPEN_GATE;
  const providers: string[] = [];
  for (const rule of routings) {
    if (!rule.enabled) continue;
    for (const provider of allowedCandidates(rule, gate))
      if (!providers.includes(provider)) providers.push(provider);
  }
  if (providers.length === 0 && routings.some((rule) => rule.enabled)) {
    // Every named gateway was revoked from the package: nothing is usable.
    return { status: "down", provider: "none" };
  }
  if (providers.length === 0) {
    // Nothing routed online: read the PRD default so a tenant that switched
    // every online method off still reports a coherent gateway.
    const fallback = routings[0]?.provider ?? "unconfigured";
    providers.push(fallback);
  }
  const readings = await Promise.all(
    providers.map(async (provider) => {
      if (!(await platformEnabled(provider))) return DISABLED_HEALTH;
      return paymentGatewayFor(provider).health(context, outletId);
    }),
  );
  let best = readings[0]!;
  for (const reading of readings)
    if (RANK[reading.status] > RANK[best.status]) best = reading;
  const allUnconfigured = readings.every(
    (reading) => reading.status === "down" && reading.reason === "unconfigured",
  );
  return {
    status: best.status,
    ...(allUnconfigured ? { reason: "unconfigured" as const } : {}),
    provider: providers.join("+"),
  };
}
