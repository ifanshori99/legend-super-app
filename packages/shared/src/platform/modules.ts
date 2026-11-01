// Feature flags & packages (PRD v1.7 §3 F4 "Feature Flag & Paket", §6 A
// `tenants.plan` + `tenants.feature_flags`, TEN-05).
//
// TEN-05: "Modul yang dimatikan melalui feature flag tidak dapat diakses lewat
// UI, API, Tanya AI, maupun MCP". Every surface calls the same
// `assertModuleEnabled`, which fails closed: a module that is missing from
// the flags, or flags that are absent or unparseable, mean "off".

import { CoreError, z } from "../core/index.ts";
import { integrationProviderSchema } from "./integrations.ts";
import type { IntegrationProvider } from "./integrations.ts";
import { tenantLimitsSchema } from "./limits.ts";

/** The 14 switchable modules named in PRD §3 F4, in PRD order. */
export const MODULE_KEYS = [
  "pos",
  "qr_order",
  "kds",
  "inventory",
  "accounting",
  "loyalty",
  "crm",
  "reservation",
  "delivery_channel", // Ojek Online (GoFood / GrabFood / ShopeeFood)
  "hris",
  "payroll",
  "shareholder_dashboard",
  "ai_assistant", // Tanya AI
  "mcp",
] as const;
export const moduleKeySchema = z.enum(MODULE_KEYS);
export type ModuleKey = z.infer<typeof moduleKeySchema>;

/** Where a module can be reached; TEN-05 lists all four. */
export const MODULE_SURFACES = ["ui", "api", "ai", "mcp"] as const;
export const moduleSurfaceSchema = z.enum(MODULE_SURFACES);
export type ModuleSurface = z.infer<typeof moduleSurfaceSchema>;

function uniqueArray<T extends z.ZodType>(item: T, label: string) {
  return z
    .array(item)
    .refine((values) => new Set(values).size === values.length, {
      message: `Duplicate ${label}`,
    });
}

/**
 * `tenants.feature_flags` JSONB. `modules` are the active modules;
 * `integrationProviders` are the gateways/vendors Super Admin made available
 * to the tenant ("gateway yang tersedia", PRD §3 F4 Super Admin). Anything not
 * listed is off.
 */
export const featureFlagsSchema = z.strictObject({
  modules: uniqueArray(moduleKeySchema, "module"),
  integrationProviders: uniqueArray(
    integrationProviderSchema,
    "integration provider",
  ),
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

/** Package key as stored in `tenants.plan` (VARCHAR(30)). Packages are data,
 * never an enum in code, so a new package needs no deploy (TEN-06). */
export const packageKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{1,29}$/, "Package key: 2-30 a-z, 0-9, _ or -");
export type PackageKey = z.infer<typeof packageKeySchema>;

/** A package Super Admin assigns: which modules it may switch on and the
 * default quotas and cost caps a new tenant starts with. */
export const platformPackageSchema = z.strictObject({
  key: packageKeySchema,
  name: z.string().trim().min(1).max(100),
  modules: uniqueArray(moduleKeySchema, "module"),
  defaultLimits: tenantLimitsSchema,
  status: z.enum(["active", "retired"]),
});
export type PlatformPackage = z.infer<typeof platformPackageSchema>;

/** Fail closed: unknown, missing or malformed flags mean every module is off. */
export function isModuleEnabled(
  flags: FeatureFlags | null | undefined,
  module: ModuleKey,
): boolean {
  if (!flags || !Array.isArray(flags.modules)) return false;
  return flags.modules.includes(module);
}

/**
 * The single TEN-05 gate. UI route guards, API middleware, Tanya AI tool
 * selection and MCP tool listing all call it, so a switched-off module is
 * unreachable everywhere at once. Throws core FEATURE_DISABLED (403).
 */
export function assertModuleEnabled(
  flags: FeatureFlags | null | undefined,
  module: ModuleKey,
  surface: ModuleSurface,
): void {
  moduleSurfaceSchema.parse(surface);
  if (!isModuleEnabled(flags, module))
    throw new CoreError(
      "FEATURE_DISABLED",
      "Modul ini tidak aktif untuk tenant Anda.",
    );
}

/** Modules a flag set switches on that the package does not include. A
 * non-empty result blocks the change with MODULE_NOT_IN_PACKAGE. */
export function modulesOutsidePackage(
  modules: readonly ModuleKey[],
  pkg: Pick<PlatformPackage, "modules">,
): ModuleKey[] {
  return modules.filter((module) => !pkg.modules.includes(module));
}

/** Filters a tool/route registry down to enabled modules (Tanya AI, MCP tool
 * listing). Items with `module: null` are core and always kept. */
export function filterByEnabledModules<T extends { module: ModuleKey | null }>(
  flags: FeatureFlags | null | undefined,
  items: readonly T[],
): T[] {
  return items.filter(
    (item) => item.module === null || isModuleEnabled(flags, item.module),
  );
}

/** Super Admin decides which gateways/vendors a tenant may connect ("gateway
 * yang tersedia"). Fail closed; a refusal is INTEGRATION_PROVIDER_NOT_AVAILABLE. */
export function isIntegrationProviderAvailable(
  flags: FeatureFlags | null | undefined,
  provider: IntegrationProvider,
): boolean {
  if (!flags || !Array.isArray(flags.integrationProviders)) return false;
  return flags.integrationProviders.includes(provider);
}
