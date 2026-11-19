// TEN-09 (PRD v1.7 §3 F4 "Konfigurasi sebagai Data & Template Tenant"): export
// a tenant's configuration as a tenant-free bundle, keep it as a global
// template, and import it into another tenant in ONE transaction.
//
// Platform admin only (the routes sit behind requirePlatformAdmin). The source
// and target tenants are path parameters chosen by that admin, so each action
// opens `platformTenantScope(tenantId)` (see platform-org.service.ts).
//
// Safety: every bundle, on export and on import, passes `parseConfigBundle`
// (schema + identifier scan). A leak on export is a bug and is never returned.
// An import writes through the per-section handlers with an `ImportKeyMap`; any
// error rolls the whole transaction back and a separate `failed` run is stored.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  configImportSchema,
  configReadinessSchema,
  configTemplateSchema,
  configTemplateSummarySchema,
  parseConfigBundle,
  PlatformError,
  scanConfigBundlePii,
  platformEvents,
  CONFIG_SECTIONS,
  type ConfigBundle,
  type ConfigImport,
  type ConfigSection,
  type ConfigTemplate,
  createConfigTemplateInputSchema,
  importConfigInputSchema,
} from "@starter/shared/platform";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ApiErrorDetail,
  type ScopedTenantContext,
  type TenantId,
  type z,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  approvalPolicies,
  brands,
  chartOfAccounts,
  configImports,
  configTemplates,
  floorZones,
  legalEntities,
  outlets,
  roles,
  taxRules,
  taxSettings,
  tenants,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./audit-writer.ts";
import { appendOutbox } from "./core-outbox.ts";
import { platformTenantScope } from "./platform-org.service.ts";
import { accessSectionHandlers } from "./tenant-config-access.ts";
import { coreSectionHandlers } from "./tenant-config-core.ts";
import { financeSectionHandlers } from "./tenant-config-finance.ts";
import { prefillImportKeys } from "./tenant-config-keys.ts";
import { lockChartOfAccounts } from "./tenant-config-locks.ts";
import { outletSectionHandlers } from "./tenant-config-outlet.ts";
import {
  ConfigImportError,
  ImportKeyMap,
  outletKey,
  type ConfigTx,
  type SectionHandler,
} from "./tenant-config-types.ts";

type CreateConfigTemplateInput = z.infer<
  typeof createConfigTemplateInputSchema
>;
type ImportConfigInput = z.infer<typeof importConfigInputSchema>;

const EVENT_DESTINATION = "cloud-sync";
const MAX_WARNINGS = 500;
const MAX_MESSAGE = 500;
const MAX_PII_DETAILS = 50;

/** Parents before children, references after what they point at. */
export const CONFIG_IMPORT_ORDER = [
  "modules",
  "text_overrides",
  "theme",
  "roles",
  "approval_policies",
  "chart_of_accounts",
  "tax_rules",
  "zones",
  "service_charge_rules",
  "checklists",
  "facilities",
  "wifi_policies",
  "loyalty_policy",
  "payroll_settings",
] as const satisfies readonly ConfigSection[];

const handlers: SectionHandler[] = [
  ...coreSectionHandlers,
  ...accessSectionHandlers,
  ...financeSectionHandlers,
  ...outletSectionHandlers,
];

/** Handlers in import order; a section without a handler is a startup bug. */
const orderedHandlers: SectionHandler[] = CONFIG_IMPORT_ORDER.map((section) => {
  const handler = handlers.find((candidate) => candidate.section === section);
  if (!handler) throw new Error(`No config handler for section ${section}`);
  return handler;
});
if (CONFIG_IMPORT_ORDER.length !== CONFIG_SECTIONS.length)
  throw new Error("CONFIG_IMPORT_ORDER does not cover every config section");

/**
 * A config error that carries `details` (import id, bundle issues). The shared
 * error handler sends code and message only, so the routes answer these
 * themselves (platform-config.routes.ts).
 */
export class ConfigDetailedError extends PlatformError {
  constructor(
    code: ConstructorParameters<typeof PlatformError>[0],
    readonly details: ApiErrorDetail[],
    message?: string,
  ) {
    super(code, message);
    this.name = "ConfigDetailedError";
  }
}

const clip = (message: string) =>
  message.length > MAX_MESSAGE
    ? `${message.slice(0, MAX_MESSAGE - 1)}…`
    : message;

// ------------------------------------------------------------------- export

async function requireTenant(tx: ConfigTx, tenantId: string) {
  const [tenant] = await tx
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return tenant;
}

/** Export on an open tenant transaction; validated, never returns a leak. */
async function exportInTx(
  tx: ConfigTx,
  ctx: ScopedTenantContext,
  tenantId: string,
  sections: readonly ConfigSection[] | undefined,
  now: Date,
): Promise<ConfigBundle> {
  await requireTenant(tx, tenantId);
  const wanted = sections ? new Set(sections) : null;
  const out: Record<string, unknown> = {};
  for (const handler of orderedHandlers) {
    if (wanted && !wanted.has(handler.section)) continue;
    const payload = await handler.exportSection({ tx, ctx, tenantId });
    if (payload === undefined) continue;
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items) && items.length === 0) continue;
    out[handler.section] = payload;
  }

  const [brandRows, legalEntityRows, outletRows] = await Promise.all([
    tx
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.tenantId, tenantId)),
    tx
      .select({ id: legalEntities.id })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId)),
    tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, tenantId)),
  ]);
  const sourceIds = [
    tenantId,
    ...brandRows.map((row) => row.id),
    ...legalEntityRows.map((row) => row.id),
    ...outletRows.map((row) => row.id),
  ];

  const parsed = parseConfigBundle(
    { formatVersion: 1, exportedAt: now.toISOString(), sections: out },
    sourceIds,
    { strictItems: true },
  );
  if (!parsed.ok) {
    // A leak is a bug in an exporter: refuse, and show the paths (never values).
    throw new ConfigDetailedError("CONFIG_BUNDLE_INVALID", [
      ...parsed.schemaIssues.map((message) => ({
        field: "schema",
        message: clip(message),
      })),
      ...parsed.identifierIssues.map((issue) => ({
        field: issue.path,
        message: issue.reason,
      })),
    ]);
  }
  return parsed.bundle;
}

/** Export a tenant's configuration (not stored). */
export async function exportTenantConfig(
  tenantId: string,
  sections?: readonly ConfigSection[],
  now = new Date(),
): Promise<ConfigBundle> {
  const ctx = platformTenantScope(tenantId);
  return withTenant(db, ctx, (tx) =>
    exportInTx(tx, ctx, tenantId, sections, now),
  );
}

// ---------------------------------------------------------------- templates

type TemplateRow = typeof configTemplates.$inferSelect;

function toTemplate(row: TemplateRow): ConfigTemplate {
  return configTemplateSchema.parse({
    id: row.id,
    name: row.name,
    sourceTenantId: row.sourceTenantId,
    version: row.version,
    payload: row.payload,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}

function toSummary(row: TemplateRow) {
  return configTemplateSummarySchema.parse({
    id: row.id,
    name: row.name,
    sourceTenantId: row.sourceTenantId,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Export `tenantId` and store it as the next version of template `name`. */
export async function createConfigTemplate(
  tenantId: string,
  input: CreateConfigTemplateInput,
  actorUserId: string,
  now = new Date(),
) {
  const ctx = platformTenantScope(tenantId);
  return withTenant(db, ctx, async (tx) => {
    const bundle = await exportInTx(tx, ctx, tenantId, input.sections, now);
    // A global template must not carry personal data typed into free text
    // (legend-ms2a). Findings are masked; the admin confirms or fixes the source.
    const piiFindings = scanConfigBundlePii(bundle.sections);
    if (piiFindings.length > 0 && input.confirmPiiFindings !== true)
      throw new ConfigDetailedError(
        "TEMPLATE_PII_FINDINGS",
        piiFindings.slice(0, MAX_PII_DETAILS).map((finding) => ({
          field: `${finding.section}.${finding.path}`,
          message: `${finding.kind}: ${finding.excerpt}`,
        })),
        // Details are capped; say how many findings there are in total.
        piiFindings.length > MAX_PII_DETAILS
          ? `Teks di konfigurasi ini tampak memuat data pribadi: ${piiFindings.length} temuan, ${MAX_PII_DETAILS} pertama ditampilkan. Periksa temuan, lalu konfirmasi bila memang aman.`
          : undefined,
      );
    // Serialise versions of one name; (name, version) is unique anyway.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`config_templates:${input.name}`}, 0))`,
    );
    const [latest] = await tx
      .select({ version: configTemplates.version })
      .from(configTemplates)
      .where(eq(configTemplates.name, input.name))
      .orderBy(desc(configTemplates.version))
      .limit(1);
    const [row] = await tx
      .insert(configTemplates)
      .values({
        name: input.name,
        version: (latest?.version ?? 0) + 1,
        sourceTenantId: tenantId,
        payload: bundle as unknown as Record<string, unknown>,
        createdBy: actorUserId,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("Config template was not saved");

    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "platform.config_template.created",
        objectType: "config_template",
        objectId: row.id,
        reason: null,
        before: null,
        after: {
          name: row.name,
          version: row.version,
          sections: Object.keys(bundle.sections),
          ...(piiFindings.length > 0
            ? {
                piiFindingsConfirmed: true,
                piiFindingCount: piiFindings.length,
                piiFindingKinds: [
                  ...new Set(piiFindings.map((finding) => finding.kind)),
                ],
              }
            : {}),
        },
        sensitiveAccess: false,
      },
      { tx, context: ctx },
    );
    return toSummary(row);
  });
}

export async function listConfigTemplates(query: {
  limit: number;
  cursor?: string;
}) {
  const filters = [];
  if (query.cursor) {
    const [createdAt, id] = decodeCursor(query.cursor);
    if (typeof createdAt !== "string" || typeof id !== "string")
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    filters.push(
      or(
        lt(configTemplates.createdAt, new Date(createdAt)),
        and(
          eq(configTemplates.createdAt, new Date(createdAt)),
          lt(configTemplates.id, id),
        ),
      ),
    );
  }
  const rows = await db
    .select()
    .from(configTemplates)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(configTemplates.createdAt), desc(configTemplates.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(toSummary),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    },
  };
}

async function findTemplateRow(templateId: string) {
  const [row] = await db
    .select()
    .from(configTemplates)
    .where(eq(configTemplates.id, templateId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Template not found.");
  return row;
}

export async function getConfigTemplate(templateId: string) {
  return toTemplate(await findTemplateRow(templateId));
}

// ------------------------------------------------------------------- import

type TargetStatusRow = { status: string };

function assertTargetActive(row: TargetStatusRow | undefined): void {
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  if (row.status !== "active") throw new PlatformError("TENANT_NOT_ACTIVE");
}

/** PostgreSQL SQLSTATE class 23 (integrity constraint violation), also when
 * the driver error is wrapped as `cause`. */
function isConstraintError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^23[0-9A-Z]{3}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Store a `failed` run in its own transaction (the apply tx rolled back). */
async function recordFailedImport(input: {
  importId: string;
  tenantId: string;
  templateId: string | null;
  actorUserId: string;
  startedAt: Date;
  message: string;
}): Promise<void> {
  const ctx = platformTenantScope(input.tenantId);
  await withTenant(db, ctx, async (tx) => {
    await tx.insert(configImports).values({
      id: input.importId,
      tenantId: input.tenantId,
      templateId: input.templateId,
      status: "failed",
      appliedSections: [],
      errors: [clip(input.message)],
      warnings: [],
      startedBy: input.actorUserId,
      startedAt: input.startedAt,
      finishedAt: new Date(),
    });
  });
}

/**
 * Import a stored template or an uploaded bundle into `targetTenantId`.
 * Invalid bundle: 422 CONFIG_BUNDLE_INVALID, nothing written. Any failure while
 * applying: everything rolls back, a `failed` run is stored and the response is
 * 422 CONFIG_IMPORT_FAILED with the run id in `details`.
 */
export async function importConfig(
  targetTenantId: string,
  input: ImportConfigInput,
  actorUserId: string,
  now = new Date(),
): Promise<ConfigImport> {
  const template = input.templateId
    ? await findTemplateRow(input.templateId)
    : null;
  const raw = template ? template.payload : input.bundle;

  const parsed = parseConfigBundle(raw, [targetTenantId], {
    strictItems: true,
  });
  if (!parsed.ok)
    throw new ConfigDetailedError("CONFIG_BUNDLE_INVALID", [
      ...parsed.schemaIssues.slice(0, 50).map((message) => ({
        field: "schema",
        message: clip(message),
      })),
      ...parsed.identifierIssues.slice(0, 50).map((issue) => ({
        field: issue.path,
        message: issue.reason,
      })),
    ]);
  const bundle = parsed.bundle;

  const [targetRow] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, targetTenantId))
    .limit(1);
  assertTargetActive(targetRow);

  const selected = input.sections ? new Set(input.sections) : null;
  const toRun = orderedHandlers.filter(
    (handler) =>
      (!selected || selected.has(handler.section)) &&
      bundle.sections[handler.section] !== undefined,
  );

  const importId = randomUUID();
  const templateId = template?.id ?? null;
  const ctx = platformTenantScope(targetTenantId);

  // Set once the `applying` row exists; from then on every error is recorded.
  let applying = false;
  try {
    return await withTenant(db, ctx, async (tx) => {
      // Chart locks first (lock order 1, tenant-config-locks.ts): owner
      // mapping writers hold them while waiting for a tenant KEY SHARE, so
      // taking them after the row lock below could deadlock. The finance
      // handler re-checks the entity list after the row lock.
      if (toRun.some((handler) => handler.section === "chart_of_accounts")) {
        const chartEntities = await tx
          .select({ id: legalEntities.id })
          .from(legalEntities)
          .where(eq(legalEntities.tenantId, targetTenantId))
          .orderBy(asc(legalEntities.createdAt), asc(legalEntities.id));
        for (const entity of chartEntities)
          await lockChartOfAccounts(tx, targetTenantId, entity.id);
      }

      // Serialise imports (and package/status changes) of the target.
      const [locked] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, targetTenantId))
        .limit(1)
        .for("update");
      assertTargetActive(locked);

      await tx.insert(configImports).values({
        id: importId,
        tenantId: targetTenantId,
        templateId,
        status: "applying",
        appliedSections: [],
        errors: [],
        warnings: [],
        startedBy: actorUserId,
        startedAt: now,
      });

      applying = true;
      const keys = new ImportKeyMap();
      const targetOutlets = await tx
        .select({ id: outlets.id, code: outlets.code })
        .from(outlets)
        .where(eq(outlets.tenantId, targetTenantId));
      for (const outlet of targetOutlets)
        keys.outlets.set(outletKey(outlet.code), outlet.id);
      await prefillImportKeys(tx, targetTenantId, keys);

      const warnings: string[] = [];
      const warn = (message: string) => {
        if (warnings.length < MAX_WARNINGS) warnings.push(clip(message));
      };
      const applied: ConfigSection[] = [];
      for (const handler of toRun) {
        await handler.importSection(
          {
            tx,
            ctx,
            tenantId: targetTenantId,
            keys,
            actorUserId,
            now,
            warn,
          },
          bundle.sections[handler.section],
        );
        applied.push(handler.section);
      }

      const finishedAt = new Date();
      const [row] = await tx
        .update(configImports)
        .set({
          status: "applied",
          appliedSections: applied,
          warnings,
          finishedAt,
        })
        .where(
          and(
            eq(configImports.tenantId, targetTenantId),
            eq(configImports.id, importId),
          ),
        )
        .returning();
      if (!row) throw new Error("Config import row was not updated");

      const definition = platformEvents["config_import.completed"];
      const event = definition.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId: targetTenantId,
        outletId: null,
        name: definition.name,
        version: definition.version,
        aggregateType: definition.entry.aggregateType,
        aggregateId: importId,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: { type: "user", id: actorUserId },
        deviceId: null,
        idempotencyKey: `${definition.name}:${importId}:1`,
        payloadSchemaRef: definition.payloadSchemaRef,
        payload: { importId, templateId, appliedSections: applied },
      });
      await appendOutbox(tx, ctx, {
        id: createUlid(now.getTime()),
        event,
        destination: EVENT_DESTINATION,
        direction: null,
        peerId: null,
      });

      await recordAudit(
        {
          tenantId: targetTenantId,
          outletId: null,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "platform.config.imported",
          objectType: "config_import",
          objectId: importId,
          reason: null,
          before: null,
          after: {
            templateId,
            appliedSections: applied,
            warningCount: warnings.length,
          },
          sensitiveAccess: false,
        },
        { tx, context: ctx },
      );

      return configImportSchema.parse({
        id: row.id,
        tenantId: row.tenantId,
        templateId: row.templateId,
        status: row.status,
        appliedSections: row.appliedSections,
        errors: row.errors,
        warnings: row.warnings,
        startedBy: row.startedBy,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      });
    });
  } catch (error) {
    // Before the `applying` row exists (target missing or inactive) nothing is
    // recorded. After it, every error leaves a `failed` run for the admin.
    if (
      !applying &&
      (error instanceof HttpError || error instanceof PlatformError)
    )
      throw error;
    const known = error instanceof ConfigImportError;
    // A constraint violation (SQLSTATE class 23) means the bundle carried a
    // value the database refuses: a bundle problem (422), not a server fault.
    const constraint = !known && isConstraintError(error);
    await recordFailedImport({
      importId,
      tenantId: targetTenantId,
      templateId,
      actorUserId,
      startedAt: now,
      message: known
        ? error.message
        : constraint
          ? "A value in the bundle violates a database constraint. Nothing was changed."
          : "The import failed unexpectedly. Nothing was changed.",
    });
    if (!known && !constraint) throw error;
    throw new ConfigDetailedError(
      "CONFIG_IMPORT_FAILED",
      [{ field: "importId", message: importId }],
      known
        ? clip(error.message)
        : "A value in the bundle violates a database constraint. Nothing was changed.",
    );
  }
}

// ---------------------------------------------------------------- readiness

/** Does the tenant have the minimum configuration to work (TEN-09)? */
export async function checkConfigReadiness(tenantId: string) {
  const ctx = platformTenantScope(tenantId);
  return withTenant(db, ctx, async (tx) => {
    const [tenant] = await tx
      .select({ featureFlags: tenants.featureFlags })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");

    const count = async (
      query: PromiseLike<Array<{ count: number }>>,
    ): Promise<number> => (await query)[0]?.count ?? 0;

    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    const add = (check: string, ok: boolean, detail: string) =>
      checks.push({ check, ok, detail });

    const moduleCount = tenant.featureFlags.modules.length;
    add(
      "modules",
      moduleCount > 0,
      moduleCount > 0 ? `${moduleCount} modules on.` : "No module is on.",
    );

    const adminRoles = await count(
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(roles)
        .where(
          and(
            eq(roles.tenantId, tenantId),
            eq(roles.isTemplate, true),
            eq(roles.templateKey, "tenant_admin"),
          ),
        ),
    );
    add(
      "roles",
      adminRoles > 0,
      adminRoles > 0
        ? "Tenant admin role exists."
        : "The tenant_admin role template is missing.",
    );

    const policies = await count(
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalPolicies)
        .where(eq(approvalPolicies.tenantId, tenantId)),
    );
    add(
      "approval_policies",
      policies > 0,
      policies > 0
        ? `${policies} approval policies.`
        : "No approval policy yet.",
    );

    // Separate grouped counts: an `sql` subquery would render bare column
    // names that resolve to the inner table.
    const entityIds = await tx
      .select({ id: legalEntities.id })
      .from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId));
    const accountsByEntity = new Map(
      (
        await tx
          .select({
            legalEntityId: chartOfAccounts.legalEntityId,
            count: sql<number>`count(*)::int`,
          })
          .from(chartOfAccounts)
          .where(eq(chartOfAccounts.tenantId, tenantId))
          .groupBy(chartOfAccounts.legalEntityId)
      ).map((row) => [row.legalEntityId as string, row.count]),
    );
    const entityRows = entityIds.map((row) => ({
      id: row.id,
      accounts: accountsByEntity.get(row.id) ?? 0,
    }));
    const withoutAccounts = entityRows.filter((row) => row.accounts === 0);
    const coaOk = entityRows.length > 0 && withoutAccounts.length === 0;
    add(
      "chart_of_accounts",
      coaOk,
      entityRows.length === 0
        ? "No legal entity yet."
        : coaOk
          ? "Every legal entity has accounts."
          : `${withoutAccounts.length} legal entities have no accounts.`,
    );

    const tenantSettings = await count(
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(taxSettings)
        .where(
          sql`${taxSettings.tenantId} = ${tenantId} AND ${taxSettings.outletId} IS NULL AND ${taxSettings.status} = 'published'`,
        ),
    );
    add(
      "tax_settings",
      tenantSettings > 0,
      tenantSettings > 0
        ? "Tenant default tax settings are published."
        : "No published tenant default tax settings.",
    );

    const publishedRules = await count(
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(taxRules)
        .where(
          sql`${taxRules.tenantId} = ${tenantId} AND ${taxRules.status} = 'published'`,
        ),
    );
    add(
      "tax_rules",
      publishedRules > 0,
      publishedRules > 0
        ? `${publishedRules} published tax rules.`
        : "No published tax rule.",
    );

    const outletIds = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, tenantId));
    const zonesByOutlet = new Map(
      (
        await tx
          .select({
            outletId: floorZones.outletId,
            count: sql<number>`count(*)::int`,
          })
          .from(floorZones)
          .where(eq(floorZones.tenantId, tenantId as TenantId))
          .groupBy(floorZones.outletId)
      ).map((row) => [row.outletId as string, row.count]),
    );
    const outletRows = outletIds.map((row) => ({
      id: row.id,
      zones: zonesByOutlet.get(row.id) ?? 0,
    }));
    const withoutZones = outletRows.filter((row) => row.zones === 0);
    const zonesOk = outletRows.length > 0 && withoutZones.length === 0;
    add(
      "zones",
      zonesOk,
      outletRows.length === 0
        ? "No outlet yet."
        : zonesOk
          ? "Every outlet has zones."
          : `${withoutZones.length} outlets have no zone.`,
    );

    return configReadinessSchema.parse({
      tenantId,
      ready: checks.every((entry) => entry.ok),
      checks,
    });
  });
}
