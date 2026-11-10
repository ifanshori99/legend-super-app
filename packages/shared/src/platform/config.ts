// Configuration as data & tenant templates (PRD v1.7 §3 F4 "Konfigurasi
// sebagai Data & Template Tenant", §6 A `config_templates`, TEN-09).
//
// TEN-09: "Konfigurasi satu tenant dapat diekspor lalu diimpor ke tenant
// baru, menghasilkan tenant yang langsung berfungsi tanpa data transaksi
// tenant asal". A bundle therefore:
// - carries configuration only, section by section (PRD list: modules,
//   roles & permissions, approval matrix, CoA, tax, service charge, zones,
//   checklists, loyalty policy, facilities, Wi-Fi, payroll; plus the term
//   dictionary and theme, which are configuration too);
// - never carries identifiers of the source tenant (tenant, brand, outlet,
//   legal entity, user, customer, order, … ids) nor secrets: rows reference
//   each other by `key`, and the importer mints fresh ids;
// - is versioned per section, so each owning domain can evolve its format.
//
// Sections whose domain contract already has a tenant-free schema are typed
// here (modules, textOverrides, theme). The rest carry `items` validated by
// `CONFIG_SECTION_ITEM_SCHEMAS` registrations from their owning domain
// (follow-up beads); until registered, items must still be plain JSON
// objects and pass the identifier scan.

import {
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { textOverrideSetSchema } from "../text/index.ts";
import {
  configBundleReferenceIssues,
  configSectionItemIssues,
} from "./config-codecs.ts";
import { configImportIdSchema, configTemplateIdSchema } from "./ids.ts";
import { featureFlagsSchema } from "./modules.ts";
import { tenantLimitsSchema } from "./limits.ts";
import { themeTokensSchema } from "./themes.ts";
import { BRAND_FONTS, CORNER_STYLES } from "../theme/types.ts";

export const CONFIG_BUNDLE_FORMAT_VERSION = 1;

/** Sections with a generic item list (owned by their domain contracts). */
export const GENERIC_CONFIG_SECTIONS = [
  "roles", // access: custom roles + permission codes (WS-01 access)
  "approval_policies", // access: approval matrix (WS-01 access)
  "chart_of_accounts", // accounting CoA template (WS-07)
  "tax_rules", // tax (WS-05)
  "service_charge_rules", // tax (WS-05)
  "zones", // tables / zones (WS-03)
  "checklists", // daily operations (WS-14)
  "loyalty_policy", // loyalty / CRM (WS-08)
  "facilities", // facility access (WS-09)
  "wifi_policies", // WFC Wi-Fi (WS-09)
  "payroll_settings", // payroll (WS-10)
] as const;
export const genericConfigSectionSchema = z.enum(GENERIC_CONFIG_SECTIONS);
export type GenericConfigSection = z.infer<typeof genericConfigSectionSchema>;

export const CONFIG_SECTIONS = [
  "modules",
  "text_overrides",
  "theme",
  ...GENERIC_CONFIG_SECTIONS,
] as const;
export const configSectionSchema = z.enum(CONFIG_SECTIONS);
export type ConfigSection = z.infer<typeof configSectionSchema>;

const jsonObject = z.record(z.string(), z.json());
const itemKey = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/);

/** A generic section: format version + items, each with a stable `key`. */
export const genericSectionSchema = z
  .strictObject({
    version: z.number().int().positive(),
    items: z.array(jsonObject.and(z.object({ key: itemKey }))).max(5_000),
  })
  .refine(
    (section) =>
      new Set(section.items.map((item) => item.key)).size ===
      section.items.length,
    { path: ["items"], message: "Duplicate item key" },
  );

export const configBundleSchema = z
  .strictObject({
    formatVersion: z.literal(CONFIG_BUNDLE_FORMAT_VERSION),
    exportedAt: isoDateTimeSchema,
    sections: z.strictObject({
      modules: z
        .strictObject({
          version: z.literal(1),
          featureFlags: featureFlagsSchema,
          limits: tenantLimitsSchema,
        })
        .optional(),
      text_overrides: z
        .strictObject({
          version: z.literal(1),
          sets: z.array(textOverrideSetSchema),
        })
        .optional(),
      theme: z
        .strictObject({
          version: z.literal(1),
          tokens: themeTokensSchema,
          fontFamily: z.enum(BRAND_FONTS),
          corners: z.enum(CORNER_STYLES),
        })
        .optional(),
      ...(Object.fromEntries(
        GENERIC_CONFIG_SECTIONS.map((section) => [
          section,
          genericSectionSchema.optional(),
        ]),
      ) as Record<
        GenericConfigSection,
        z.ZodOptional<typeof genericSectionSchema>
      >),
    }),
  })
  .superRefine((bundle, ctx) => {
    // Sections whose domain registered a codec (config-codecs.ts) must carry
    // items its item schema accepts; the rest stay free-form JSON.
    const itemIssues = GENERIC_CONFIG_SECTIONS.flatMap((section) =>
      configSectionItemIssues(section, bundle.sections[section]),
    );
    // References (role keys, CoA parents) and uniqueness are only checked
    // once every item is well-formed, so a stored template is importable.
    for (const issue of itemIssues.length > 0
      ? itemIssues
      : configBundleReferenceIssues(bundle))
      ctx.addIssue({ code: "custom", ...issue });
  });
export type ConfigBundle = z.infer<typeof configBundleSchema>;

/**
 * Keys that identify rows of a specific tenant or carry transaction data or
 * secrets. A bundle containing any of them (at any depth) is refused.
 */
const FORBIDDEN_KEY =
  /^(id|tenantid|brandid|outletid|legalentityid|userid|employeeid|customerid|memberid|orderid|paymentid|invoiceid|ticketid|deviceid|edgenodeid|createdby|updatedby|approvedby|secretref|credentials?|npwp|phone|email|whatsapp)$/;
const UUID_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type BundleIdentifierIssue = { path: string; reason: string };

/**
 * TEN-09 scan: every place a bundle still carries a tenant-bound identifier
 * (forbidden key, any UUID-looking text, or one of `sourceIds` verbatim).
 * Empty result = safe to store as a template or import.
 */
export function findBundleIdentifiers(
  value: unknown,
  sourceIds: readonly string[] = [],
): BundleIdentifierIssue[] {
  const wanted = sourceIds.map((id) => id.toLowerCase());
  const issues: BundleIdentifierIssue[] = [];
  const visit = (node: unknown, path: string) => {
    if (typeof node === "string") {
      const lower = node.toLowerCase();
      if (UUID_TEXT.test(node)) issues.push({ path, reason: "uuid" });
      else if (wanted.some((id) => lower.includes(id)))
        issues.push({ path, reason: "source_id" });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const normalized = key.replaceAll("_", "").toLowerCase();
        const at = path ? `${path}.${key}` : key;
        if (FORBIDDEN_KEY.test(normalized))
          issues.push({ path: at, reason: "forbidden_key" });
        visit(child, at);
      }
    }
  };
  visit(value, "");
  return issues;
}

/** Parse + identifier scan; the one entry point for export and import. */
export function parseConfigBundle(
  input: unknown,
  sourceIds: readonly string[] = [],
):
  | { ok: true; bundle: ConfigBundle }
  | {
      ok: false;
      schemaIssues: string[];
      identifierIssues: BundleIdentifierIssue[];
    } {
  const parsed = configBundleSchema.safeParse(input);
  const identifierIssues = findBundleIdentifiers(input, sourceIds);
  if (parsed.success && identifierIssues.length === 0)
    return { ok: true, bundle: parsed.data };
  return {
    ok: false,
    schemaIssues: parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
        ),
    identifierIssues,
  };
}

/** `config_templates` (global). `sourceTenantId` is provenance metadata on
 * the row, never inside the payload. */
export const configTemplateSchema = z.strictObject({
  id: configTemplateIdSchema,
  name: z.string().trim().min(3).max(120),
  sourceTenantId: tenantIdSchema.nullable(),
  version: z.number().int().positive(),
  payload: configBundleSchema,
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type ConfigTemplate = z.infer<typeof configTemplateSchema>;

/** Template summary for lists (payload left out). */
export const configTemplateSummarySchema = configTemplateSchema.omit({
  payload: true,
});

export const createConfigTemplateInputSchema = z.strictObject({
  name: configTemplateSchema.shape.name,
  /** Sections to include; default all present in the source tenant. */
  sections: z.array(configSectionSchema).min(1).optional(),
});

/** Import into a tenant: from a stored template or an uploaded bundle. */
export const importConfigInputSchema = z
  .strictObject({
    templateId: configTemplateIdSchema.optional(),
    bundle: z.unknown().optional(),
    sections: z.array(configSectionSchema).min(1).optional(),
  })
  .refine(
    (input) =>
      (input.templateId === undefined) !== (input.bundle === undefined),
    { message: "Give exactly one of templateId or bundle" },
  );

export const configImportStatusSchema = z.enum([
  "validating",
  "applying",
  "applied",
  "failed",
]);
export type ConfigImportStatus = z.infer<typeof configImportStatusSchema>;

const importTransitions: Record<
  ConfigImportStatus,
  readonly ConfigImportStatus[]
> = {
  validating: ["applying", "failed"],
  applying: ["applied", "failed"],
  applied: [],
  failed: [],
};
export function canTransitionConfigImport(
  from: ConfigImportStatus,
  to: ConfigImportStatus,
): boolean {
  return importTransitions[from].includes(to);
}

/** An import run into one target tenant. All sections apply in one
 * transaction: a failure leaves the target unchanged. */
export const configImportSchema = z.strictObject({
  id: configImportIdSchema,
  tenantId: tenantIdSchema,
  templateId: configTemplateIdSchema.nullable(),
  status: configImportStatusSchema,
  appliedSections: z.array(configSectionSchema),
  errors: z.array(z.string().max(500)).max(200),
  startedBy: userIdSchema,
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
});
export type ConfigImport = z.infer<typeof configImportSchema>;
