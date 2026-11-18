// TEN-09: core configuration sections of a tenant config bundle: modules,
// text overrides, theme and the two sections without a table yet (loyalty
// policy, payroll settings). Everything is exported tenant-free and imported
// idempotently (insert missing rows only, never edit existing ones).

import { and, asc, eq } from "drizzle-orm";
import {
  checkThemeTokens,
  modulesOutsidePackage,
  tenantLimitsSchema,
  type ConfigBundle,
  type ConfigSection,
} from "@starter/shared/platform";
import {
  brands,
  platformPackages,
  tenants,
  tenantThemes,
  textOverrides,
} from "../db/schema/index.ts";
import {
  ConfigImportError,
  type ExportContext,
  type ImportContext,
  type SectionHandler,
} from "./tenant-config-types.ts";

type ModulesPayload = NonNullable<ConfigBundle["sections"]["modules"]>;
type TextOverridesPayload = NonNullable<
  ConfigBundle["sections"]["text_overrides"]
>;
type ThemePayload = NonNullable<ConfigBundle["sections"]["theme"]>;

/** Order-insensitive JSON comparison for small config objects. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// ------------------------------------------------------------------ modules

const modulesHandler: SectionHandler = {
  section: "modules",
  async exportSection({ tx, tenantId }: ExportContext) {
    const [row] = await tx
      .select({ featureFlags: tenants.featureFlags, limits: tenants.limits })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) return undefined;
    const payload: ModulesPayload = {
      version: 1,
      featureFlags: {
        modules: [...row.featureFlags.modules],
        integrationProviders: [...row.featureFlags.integrationProviders],
      },
      limits: tenantLimitsSchema.parse(row.limits),
    };
    return payload;
  },
  async importSection({ tx, tenantId, warn }: ImportContext, payload: unknown) {
    const bundle = payload as ModulesPayload;
    const [target] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!target) throw new ConfigImportError("Target tenant not found.");
    const [pkg] = await tx
      .select({ modules: platformPackages.modules })
      .from(platformPackages)
      .where(eq(platformPackages.key, target.plan))
      .limit(1);
    if (!pkg)
      throw new ConfigImportError(
        `The target package "${target.plan}" does not exist.`,
      );

    const modules = [
      ...new Set([
        ...target.featureFlags.modules,
        ...bundle.featureFlags.modules,
      ]),
    ];
    const outside = modulesOutsidePackage(modules, pkg);
    if (outside.length > 0)
      throw new ConfigImportError(
        `MODULE_NOT_IN_PACKAGE: ${outside.join(", ")} not in the target package "${target.plan}".`,
      );
    const integrationProviders = [
      ...new Set([
        ...target.featureFlags.integrationProviders,
        ...bundle.featureFlags.integrationProviders,
      ]),
    ];
    // Limits belong to the package; a bundle never changes them.
    if (
      stableJson(tenantLimitsSchema.parse(target.limits)) !==
      stableJson(tenantLimitsSchema.parse(bundle.limits))
    )
      warn("Limits differ from the template and were left unchanged.");

    if (
      modules.length === target.featureFlags.modules.length &&
      integrationProviders.length ===
        target.featureFlags.integrationProviders.length
    )
      return;
    await tx
      .update(tenants)
      .set({ featureFlags: { modules, integrationProviders } })
      .where(eq(tenants.id, tenantId));
  },
};

// ----------------------------------------------------------- text overrides

const textOverridesHandler: SectionHandler = {
  section: "text_overrides",
  async exportSection({ tx, tenantId }: ExportContext) {
    const rows = await tx
      .select({
        locale: textOverrides.locale,
        key: textOverrides.key,
        value: textOverrides.value,
      })
      .from(textOverrides)
      .where(eq(textOverrides.tenantId, tenantId))
      .orderBy(asc(textOverrides.locale), asc(textOverrides.key));
    if (rows.length === 0) return undefined;
    const sets = new Map<string, Array<{ key: string; value: string }>>();
    for (const row of rows) {
      const list = sets.get(row.locale) ?? [];
      list.push({ key: row.key, value: row.value });
      sets.set(row.locale, list);
    }
    return {
      version: 1,
      sets: [...sets].map(([locale, overrides]) => ({ locale, overrides })),
    };
  },
  async importSection(
    { tx, tenantId, actorUserId, now }: ImportContext,
    payload: unknown,
  ) {
    const bundle = payload as TextOverridesPayload;
    const values = bundle.sets.flatMap((set) =>
      set.overrides.map((override) => ({
        tenantId,
        locale: set.locale,
        key: override.key,
        value: override.value,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })),
    );
    if (values.length === 0) return;
    // Existing (locale, key) rows keep the target's own wording.
    await tx.insert(textOverrides).values(values).onConflictDoNothing();
  },
};

// -------------------------------------------------------------------- theme

/** The brand a bundle theme belongs to: the tenant's oldest brand. */
async function primaryBrandId(
  tx: ExportContext["tx"],
  tenantId: string,
): Promise<string | undefined> {
  const [brand] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.tenantId, tenantId))
    .orderBy(asc(brands.createdAt), asc(brands.id))
    .limit(1);
  return brand?.id;
}

const themeHandler: SectionHandler = {
  section: "theme",
  async exportSection({ tx, tenantId }: ExportContext) {
    const brandId = await primaryBrandId(tx, tenantId);
    if (!brandId) return undefined;
    const [theme] = await tx
      .select()
      .from(tenantThemes)
      .where(
        and(
          eq(tenantThemes.tenantId, tenantId),
          eq(tenantThemes.brandId, brandId),
          eq(tenantThemes.status, "active"),
        ),
      )
      .limit(1);
    if (!theme) return undefined;
    const payload: ThemePayload = {
      version: 1,
      tokens: theme.tokens,
      fontFamily: theme.fontFamily as ThemePayload["fontFamily"],
      corners: theme.corners as ThemePayload["corners"],
    };
    return payload;
  },
  async importSection(
    { tx, tenantId, actorUserId, now, warn }: ImportContext,
    payload: unknown,
  ) {
    const bundle = payload as ThemePayload;
    const brandId = await primaryBrandId(tx, tenantId);
    if (!brandId) {
      warn("Theme skipped: the target tenant has no brand yet.");
      return;
    }
    const [existing] = await tx
      .select({ id: tenantThemes.id })
      .from(tenantThemes)
      .where(
        and(
          eq(tenantThemes.tenantId, tenantId),
          eq(tenantThemes.brandId, brandId),
        ),
      )
      .limit(1);
    if (existing) {
      warn("Theme skipped: the target brand already has a theme.");
      return;
    }
    // TEN-10: the server re-checks contrast; a failing theme stays a draft.
    const passes = checkThemeTokens(bundle.tokens).ok;
    const [row] = await tx
      .insert(tenantThemes)
      .values({
        tenantId,
        brandId,
        version: 1,
        tokens: bundle.tokens,
        fontFamily: bundle.fontFamily,
        corners: bundle.corners,
        contrastCheckPassed: passes,
        status: passes ? "active" : "draft",
        createdBy: actorUserId,
        createdAt: now,
        activatedAt: passes ? now : null,
      })
      .returning({ id: tenantThemes.id });
    if (!passes) {
      warn(
        "Theme imported as a draft: it fails the WCAG 2.2 AA contrast check.",
      );
      return;
    }
    if (row)
      await tx
        .update(brands)
        .set({ themeId: row.id })
        .where(and(eq(brands.tenantId, tenantId), eq(brands.id, brandId)));
  },
};

// ------------------------------------------- sections without a table yet

/** Export omits the section; import accepts empty/absent only. */
function unsupportedSection(section: ConfigSection): SectionHandler {
  return {
    section,
    exportSection: async () => undefined,
    importSection: async (_input: ImportContext, payload: unknown) => {
      const items = (payload as { items?: unknown[] } | undefined)?.items;
      if (Array.isArray(items) && items.length > 0)
        throw new ConfigImportError(`Section ${section} is not supported yet.`);
    },
  };
}

export const coreSectionHandlers: SectionHandler[] = [
  modulesHandler,
  textOverridesHandler,
  themeHandler,
  // GUARD (legend-85qyi): when the loyalty_policy import handler is built, its
  // update of an existing program must OMIT `legalEntityId` from the update
  // input (never write null): a program's legal entity (PT) is not in the
  // config bundle and must never be wiped by an import. Requirement: replace
  // the "still rejects" test in test/tenant-config-loyalty-import-guard.test.ts
  // with a DB test proving an import keeps the PT of an existing program.
  unsupportedSection("loyalty_policy"),
  unsupportedSection("payroll_settings"),
];
