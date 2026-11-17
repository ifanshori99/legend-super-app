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
// `configSectionItemSchemas` (strict, one schema per section; multi-kind
// sections discriminate on `kind`). Items reference each other by `*Key`
// fields, never by id.

import {
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  posDiscountThresholdBpSchema,
  roundingModeSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import {
  accountTypeSchema,
  postingAccountRoleSchema,
  reportGroupSchema,
} from "../accounting/coa.ts";
import { scopeTypeSchema } from "../access/scope.ts";
import {
  cancellationPolicySchema,
  entitlementRuleSchema,
  entitlementValiditySchema,
  facilityTypeSchema,
  facilityUnitStatusSchema,
  overtimePolicySchema,
  subscriptionIntervalSchema,
} from "../facility/schemas.ts";
import { facilityHoursSchema } from "../facility/slots.ts";
import { checklistTemplateTypeSchema } from "../operations/schemas.ts";
import {
  paymentModeSchema,
  zoneHoursSchema,
  zoneStatusSchema,
} from "../qr-order/schemas.ts";
import {
  calculationOrderSchema,
  itemTaxClassSchema,
  packageAllocationMethodSchema,
  taxChannelSchema,
  taxTypeSchema,
} from "../tax/schemas.ts";
import { textOverrideSetSchema } from "../text/index.ts";
import { itemKey, wifiPolicyItemSchema } from "./config-items.ts";
import { loyaltyPolicyConfigItemSchema } from "../crm/config-codec.ts";
import { payrollSettingsConfigItemSchema } from "../hris/payroll/config-codec.ts";
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

/** Sections a tenant admin may not import themselves (access, money, tax,
 * loyalty, payroll, facility rules). Only the platform admin path applies
 * them. */
export const TENANT_IMPORT_BLOCKED_SECTIONS = [
  "roles",
  "approval_policies",
  "chart_of_accounts",
  "tax_rules",
  "service_charge_rules",
  "loyalty_policy",
  "payroll_settings",
  "facilities",
  "wifi_policies",
] as const satisfies readonly ConfigSection[];

const jsonObject = z.record(z.string(), z.json());

// ---- Item schemas (TEN-09) -------------------------------------------------
// Every item has a `key`. References to other rows are `*Key` fields (the
// importer resolves them), never ids. Field names must not match the
// identifier scan below (no `id`, `outletId`, `createdBy`, `email`, …).

/** Lower-cased source outlet code; resolved to a target outlet by code. */
const outletKeySchema = itemKey;
const money = z.number().int().min(0);
const minutes = z.number().int().min(0).max(1440);
const sortOrder = z.number().int().min(0);
/** DB checks: sessions 1..100, per-day cap 1..10 (facility_products,
 * entitlement_rules, facility_subscription_plans). */
const sessionCount = z.number().int().min(1).max(100);
const maxPerDay = z.number().int().min(1).max(10).nullable();
const shortName = z.string().trim().min(1).max(150);
/** `<module>.<resource>.<action>` text; the importer checks it against the
 * catalog (unknown or platform-tagged codes fail the import, not the parse). */
const permissionCodeText = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/)
  .max(100);

const roleItemSchema = z.strictObject({
  key: itemKey,
  kind: z.enum(["template", "custom"]),
  /** Set for template roles (matched by `template_key` on import). */
  templateKey: z.string().min(1).max(60).nullable(),
  name: z.string().trim().min(1).max(100),
  permissions: z.array(permissionCodeText).max(500),
  mfaRequired: z.boolean(),
  allowedScopeTypes: z
    .array(scopeTypeSchema)
    .max(scopeTypeSchema.options.length),
});

const approvalItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    key: itemKey,
    kind: z.literal("approval"),
    actionType: z.string().min(1).max(50),
    thresholdIdr: money.nullable(),
    approverRoleKey: itemKey,
    levels: z.number().int().min(1).max(10),
    requiresDistinctActor: z.boolean(),
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("pos_discount"),
    /** null = the tenant-wide threshold. */
    outletKey: outletKeySchema.nullable(),
    discountThresholdBp: posDiscountThresholdBpSchema,
  }),
]);

const chartOfAccountsItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    key: itemKey,
    kind: z.literal("account"),
    code: z.string().min(1).max(20),
    name: shortName,
    type: accountTypeSchema,
    reportGroup: reportGroupSchema,
    /** Key of the parent account in the same section; null for a root. */
    parentKey: itemKey.nullable(),
    isActive: z.boolean(),
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("mapping"),
    role: postingAccountRoleSchema,
    accountKey: itemKey,
  }),
]);

const taxItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    key: itemKey,
    kind: z.literal("rule"),
    /** null = tenant default rule. */
    outletKey: outletKeySchema.nullable(),
    code: z.string().min(1).max(40),
    name: shortName,
    taxType: taxTypeSchema,
    rateBp: basisPointsSchema,
    regionCode: z.string().min(1).max(20).nullable(),
    channels: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
    /** Tax classes only: category and menu-item targets are menu data and do
     * not travel, so a rule that covers no class cannot be exported. */
    appliesTo: z.strictObject({
      itemClasses: z
        .array(itemTaxClassSchema)
        .min(1)
        .max(itemTaxClassSchema.options.length),
    }),
    priceIncludesTax: z.boolean(),
    includeServiceInBase: z.boolean(),
    /** Older stored exports did not carry the effective business date. */
    effectiveFrom: businessDateSchema.optional(),
    isActive: z.boolean(),
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("settings"),
    outletKey: outletKeySchema.nullable(),
    calculationOrder: calculationOrderSchema,
    pricesIncludeTax: z.boolean(),
    serviceRoundingMode: roundingModeSchema,
    taxRoundingMode: roundingModeSchema,
    inclusiveBaseRoundingMode: roundingModeSchema,
    billRounding: z
      .strictObject({
        incrementIdr: z.number().int().positive().max(100_000),
        mode: roundingModeSchema,
      })
      .nullable(),
    packageAllocation: packageAllocationMethodSchema,
  }),
]);

const serviceChargeItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema.nullable(),
  code: z.string().min(1).max(40),
  name: shortName,
  rateBp: basisPointsSchema,
  /** Zone the charge is bound to (a `zones` item key); null = outlet-wide. */
  zoneKey: itemKey.nullable(),
  orderTypes: z.array(taxChannelSchema).max(taxChannelSchema.options.length),
  itemClasses: z
    .array(itemTaxClassSchema)
    .min(1)
    .max(itemTaxClassSchema.options.length),
  /** Older stored exports did not carry the effective business date. */
  effectiveFrom: businessDateSchema.optional(),
  isActive: z.boolean(),
});

const zoneItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  name: shortName,
  paymentMode: paymentModeSchema,
  serviceChargeBp: basisPointsSchema,
  minimumSpendIdr: money,
  hours: z.array(zoneHoursSchema).max(50),
  status: zoneStatusSchema,
  sortOrder,
  isWfc: z.boolean().optional(),
});

const checklistItemEntrySchema = z.strictObject({
  label: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(1000).nullable(),
  requiredEvidence: z.array(z.enum(["photo", "number", "signature"])).max(3),
});
const checklistItemSchema = z.strictObject({
  key: itemKey,
  outletKey: outletKeySchema,
  name: shortName,
  type: checklistTemplateTypeSchema,
  /** Entries without ids; the importer mints fresh ones. */
  items: z.array(checklistItemEntrySchema).min(1).max(100),
  /** Shift and station references are dropped; the zone travels as a key. */
  schedule: z.strictObject({
    dueTime: z.iso.time({ precision: -1 }),
    zoneKey: itemKey.nullable(),
  }),
  /** Source role as a `roles` item key; null = any role. */
  roleKey: itemKey.nullable(),
});

/** Condition shape per entitlement type, from the facility contract. `package`
 * rules point at a menu item (not portable) and are refused in a bundle. */
const entitlementConditionSchemas = {
  min_spend: entitlementRuleSchema.options[0].shape.condition,
  tier_benefit: entitlementRuleSchema.options[1].shape.condition,
} as const;

const facilityItemSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      key: itemKey,
      kind: z.literal("facility"),
      outletKey: outletKeySchema,
      name: shortName,
      type: facilityTypeSchema,
      sessionMinutes: z.number().int().min(1).max(480),
      cleaningMinutes: z.number().int().min(0).max(240),
      arrivalGraceMinutes: minutes,
      operatingHours: facilityHoursSchema,
      overtimePolicy: overtimePolicySchema,
      cancellationPolicy: cancellationPolicySchema,
    })
    .refine((item) => item.sessionMinutes + item.cleaningMinutes <= 720, {
      path: ["cleaningMinutes"],
      message: "sessionMinutes + cleaningMinutes must be at most 720",
    }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("area"),
    facilityKey: itemKey,
    name: shortName,
    sortOrder,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("unit"),
    facilityKey: itemKey,
    areaKey: itemKey,
    code: z.string().min(1).max(20),
    status: facilityUnitStatusSchema,
    sortOrder,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("product"),
    facilityKey: itemKey,
    name: shortName,
    type: z.enum(["single", "package_component", "subscription_plan"]),
    priceIdr: money,
    sessions: sessionCount,
    isActive: z.boolean(),
    /** A `tax_rules` rule key; null = default tax. */
    taxRuleKey: itemKey.nullable(),
    maxPerDay,
  }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("addon"),
    facilityKey: itemKey,
    name: shortName,
    priceIdr: money,
    isEnabled: z.boolean(),
    sortOrder,
  }),
  z
    .strictObject({
      key: itemKey,
      kind: z.literal("entitlement"),
      facilityKey: itemKey,
      type: z.enum(["min_spend", "tier_benefit"]),
      condition: jsonObject,
      sessions: sessionCount,
      validity: entitlementValiditySchema,
      isEnabled: z.boolean(),
    })
    .superRefine((item, ctx) => {
      const result = entitlementConditionSchemas[item.type].safeParse(
        item.condition,
      );
      if (!result.success)
        ctx.addIssue({
          code: "custom",
          path: ["condition"],
          message: `Invalid condition for a ${item.type} entitlement`,
        });
    }),
  z.strictObject({
    key: itemKey,
    kind: z.literal("subscription_plan"),
    facilityKey: itemKey,
    name: shortName,
    priceIdr: money,
    quotaPerPeriod: sessionCount,
    interval: subscriptionIntervalSchema,
    maxPerDay,
    isActive: z.boolean(),
  }),
]);

/** One strict item schema per generic section. */
export const configSectionItemSchemas: Record<GenericConfigSection, z.ZodType> =
  {
    roles: roleItemSchema,
    approval_policies: approvalItemSchema,
    chart_of_accounts: chartOfAccountsItemSchema,
    tax_rules: taxItemSchema,
    service_charge_rules: serviceChargeItemSchema,
    zones: zoneItemSchema,
    checklists: checklistItemSchema,
    loyalty_policy: loyaltyPolicyConfigItemSchema,
    facilities: facilityItemSchema,
    wifi_policies: wifiPolicyItemSchema,
    payroll_settings: payrollSettingsConfigItemSchema,
  };

/** Loose item for previewing unvalidated sections. */
const unsupportedItemSchema = jsonObject.and(z.object({ key: itemKey }));

/** A generic section: format version + items, each with a stable `key`. */
function genericSectionOf(item: z.ZodType) {
  return z
    .strictObject({
      version: z.number().int().positive(),
      items: z.array(item).max(5_000),
    })
    .refine(
      (section) =>
        new Set(section.items.map((entry) => (entry as { key: string }).key))
          .size === section.items.length,
      { path: ["items"], message: "Duplicate item key" },
    );
}
export const genericSectionSchema = genericSectionOf(unsupportedItemSchema);

/**
 * Bundle shape. `strictItems` validates every generic section's items with
 * `configSectionItemSchemas` (the server's import/export boundary); the loose
 * form (any JSON item with a key) is what a browser preview needs to diff an
 * older or hand-edited file before the server judges it.
 */
function bundleSchemaOf(strictItems: boolean) {
  return z.strictObject({
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
          (strictItems
            ? genericSectionOf(configSectionItemSchemas[section])
            : genericSectionSchema
          ).optional(),
        ]),
      ) as Record<
        GenericConfigSection,
        z.ZodOptional<typeof genericSectionSchema>
      >),
    }),
  });
}
export const configBundleSchema = bundleSchemaOf(false).superRefine(
  (bundle, ctx) => {
    // Sections whose domain registered a codec (config-codecs.ts) must carry
    // items its item schema accepts (the `kind` shape of
    // `configSectionItemSchemas`, or the old kind-less shape); the rest stay
    // free-form JSON.
    const itemIssues = GENERIC_CONFIG_SECTIONS.flatMap((section) =>
      configSectionItemIssues(section, bundle.sections[section]),
    );
    // References (role keys, CoA parents, mapping accounts) and uniqueness are
    // only checked once every item is well-formed, so a stored template is
    // importable.
    for (const issue of itemIssues.length > 0
      ? itemIssues
      : configBundleReferenceIssues(bundle))
      ctx.addIssue({ code: "custom", ...issue });
  },
);
/** Server boundary: every generic item must match its section schema. */
export const strictConfigBundleSchema = bundleSchemaOf(true);
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
        else if (UUID_TEXT.test(key)) issues.push({ path: at, reason: "uuid" });
        else if (wanted.some((id) => key.toLowerCase().includes(id)))
          issues.push({ path: at, reason: "source_id" });
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
  options: { strictItems?: boolean } = {},
):
  | { ok: true; bundle: ConfigBundle }
  | {
      ok: false;
      schemaIssues: string[];
      identifierIssues: BundleIdentifierIssue[];
    } {
  const parsed = (
    options.strictItems ? strictConfigBundleSchema : configBundleSchema
  ).safeParse(input);
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

/** Pre-codec zone exports carried presentation data, not importable charges. */
const legacyStoredZoneItemSchema = z.strictObject({
  key: itemKey,
  name: shortName,
  tableCount: z.number().int().nonnegative().optional(),
});

/**
 * Read old persisted payloads without manufacturing the financial fields their
 * exporters never wrote. Import still validates the untouched payload through
 * strictConfigBundleSchema. Only the former zone shape and kind-less loyalty
 * JSON get this compatibility path; malformed current items remain errors.
 */
const storedConfigBundleSchema = bundleSchemaOf(false).superRefine(
  (bundle, ctx) => {
    const sections = { ...bundle.sections };
    const zones = sections.zones;
    if (
      zones?.version === 1 &&
      zones.items.length > 0 &&
      zones.items.every(
        (item) => legacyStoredZoneItemSchema.safeParse(item).success,
      )
    )
      delete sections.zones;
    const loyalty = sections.loyalty_policy;
    if (
      loyalty?.version === 1 &&
      loyalty.items.length > 0 &&
      loyalty.items.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !Object.hasOwn(item, "kind"),
      )
    )
      delete sections.loyalty_policy;
    const payroll = sections.payroll_settings;
    if (
      payroll?.version === 1 &&
      payroll.items.length > 0 &&
      payroll.items.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !Object.hasOwn(item, "kind"),
      )
    )
      delete sections.payroll_settings;

    // The remaining sections keep the current item and reference checks. A
    // legacy section is unavailable for those checks, like a partial template
    // whose referenced configuration will be supplied by the target tenant.
    const current = configBundleSchema.safeParse({ ...bundle, sections });
    if (!current.success)
      for (const issue of current.error.issues) ctx.addIssue({ ...issue });
    for (const issue of findBundleIdentifiers(bundle))
      ctx.addIssue({
        code: "custom",
        message: `${issue.path}: ${issue.reason}`,
      });
  },
);

/** `config_templates` (global). `sourceTenantId` is provenance metadata on
 * the row, never inside the payload. */
export const configTemplateSchema = z.strictObject({
  id: configTemplateIdSchema,
  name: z.string().trim().min(3).max(120),
  sourceTenantId: tenantIdSchema.nullable(),
  version: z.number().int().positive(),
  payload: storedConfigBundleSchema,
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
  /** Store the template although the personal-data scan has findings (legend-ms2a). */
  confirmPiiFindings: z.boolean().optional(),
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

/** Tenant self-service import: an uploaded bundle only, never a template. */
export const orgImportConfigInputSchema = z
  .strictObject({
    bundle: z.unknown(),
    sections: z.array(configSectionSchema).min(1).optional(),
  })
  .refine((input) => input.bundle !== undefined, {
    message: "bundle is required",
    path: ["bundle"],
  });

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
  /** Non-fatal notes (e.g. items skipped because the target has no such outlet). */
  warnings: z.array(z.string().max(500)).max(500),
  startedBy: userIdSchema,
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
});
export type ConfigImport = z.infer<typeof configImportSchema>;

/** Readiness of a tenant after an import: can it run? (TEN-09 "langsung berfungsi") */
export const CONFIG_READINESS_CHECKS = [
  "modules",
  "roles",
  "approval_policies",
  "chart_of_accounts",
  "tax_settings",
  "tax_rules",
  "zones",
] as const;
export const configReadinessCheckSchema = z.enum(CONFIG_READINESS_CHECKS);
export type ConfigReadinessCheck = z.infer<typeof configReadinessCheckSchema>;

export const configReadinessSchema = z.strictObject({
  tenantId: tenantIdSchema,
  ready: z.boolean(),
  checks: z
    .array(
      z.strictObject({
        check: configReadinessCheckSchema,
        ok: z.boolean(),
        detail: z.string().max(500),
      }),
    )
    .max(CONFIG_READINESS_CHECKS.length),
});
export type ConfigReadiness = z.infer<typeof configReadinessSchema>;
