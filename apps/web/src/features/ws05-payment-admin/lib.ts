// Pure helpers for the payment back office. No React and no `@/` alias, so
// tests can import this file with plain Node ESM.
import type { PermissionCode } from "@starter/shared/access";
import type { MessageKey } from "@starter/shared/i18n";
import type { PaymentProvider } from "@starter/shared/payment/admin";

/** Gateway routing GET/PUT need this permission (sub-302 D14), not EDC's. */
export const ROUTING_MANAGE_PERMISSION: PermissionCode = "org.settings.manage";

/** Duitku credentials PUT/test need this permission (sub-302 D15-D16). */
export const INTEGRATION_MANAGE_PERMISSION: PermissionCode =
  "org.integration.manage";

/** Permissions that may open /kelola/pembayaran (any one is enough). */
export const PAYMENT_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  "payment.transaction.view",
  "payment.reconcile",
  "payment.edc.manage",
  ROUTING_MANAGE_PERMISSION,
  INTEGRATION_MANAGE_PERMISSION,
];

export type PaymentAdminTab =
  "routing" | "duitku" | "edc" | "refunds" | "unallocated" | "reconciliation";

/**
 * Tab order with the permissions each tab's API reads need (any one is
 * enough), taken from apps/api/src/routes/payment-admin.routes.ts: refunds
 * list is gated by payment.transaction.view; unallocated funds and
 * reconciliation by payment.reconcile.
 */
export const PAYMENT_ADMIN_TABS: ReadonlyArray<{
  readonly tab: PaymentAdminTab;
  readonly permissions: readonly PermissionCode[];
}> = [
  { tab: "routing", permissions: [ROUTING_MANAGE_PERMISSION] },
  { tab: "duitku", permissions: [INTEGRATION_MANAGE_PERMISSION] },
  { tab: "edc", permissions: ["payment.edc.manage"] },
  { tab: "refunds", permissions: ["payment.transaction.view"] },
  { tab: "unallocated", permissions: ["payment.reconcile"] },
  { tab: "reconciliation", permissions: ["payment.reconcile"] },
];

/** Tabs the holder may open, in display order. The first one is the default. */
export function visiblePaymentAdminTabs(
  held: readonly string[],
): PaymentAdminTab[] {
  return PAYMENT_ADMIN_TABS.filter((entry) =>
    entry.permissions.some((code) => held.includes(code)),
  ).map((entry) => entry.tab);
}

/** Indonesian message key for a failed routing save; never the raw API text. */
export function routingSaveErrorKey(error: unknown): MessageKey {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (
    code === "VALIDATION_ERROR" &&
    typeof message === "string" &&
    message.startsWith("GATEWAY_NOT_AVAILABLE")
  )
    return "paymentAdmin.routing.errors.gatewayNotAvailable";
  switch (code) {
    case "VALIDATION_ERROR":
      return "paymentAdmin.routing.errors.invalid";
    case "FORBIDDEN":
      return "paymentAdmin.routing.errors.forbidden";
    case "NOT_FOUND":
      return "paymentAdmin.routing.errors.notFound";
    case "CONFLICT":
    case "IDEMPOTENCY_KEY_REUSED":
      return "paymentAdmin.routing.errors.conflict";
    case "NETWORK_ERROR":
      return "paymentAdmin.routing.errors.offline";
    default:
      return "paymentAdmin.routing.errors.generic";
  }
}

/**
 * Backup gateway choices for one method: enabled providers only, never the
 * primary one (sub-302 D12). "No backup" is added by the caller.
 */
export function fallbackProviderOptions(
  providers: readonly PaymentProvider[],
  primary: string,
): PaymentProvider[] {
  return providers.filter(
    (provider) => provider.enabled && provider.code !== primary,
  );
}

/**
 * Route loaders skip the SSR prefetch when the URL asks for a mock scenario
 * (?mock=empty|slow|error|offline): the scenario lives in the browser, so a
 * server-prefetched page would otherwise never show the state.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
