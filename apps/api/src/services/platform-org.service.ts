// Panel Platform org services (PRD v1.7 §3 F4, flow R; TEN-06).
//
// A Super Admin creates tenants, changes a tenant's status and assigns its
// package/flags/quotas. Every row is data: no tenant is a code branch and no
// change needs a deploy. The caller's platform permission is checked at the
// route; this module owns the rules and the SQL.
//
// These are the only services that run without a tenant transaction: `tenants`
// and `platform_packages` are global tables with explicit GRANTs to legend_app.
// Tenant-owned rows are only reached through org.service.ts, under RLS.

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ilike, lt, or } from "drizzle-orm";
import {
  PAYMENT_GATEWAY_PROVIDERS,
  PlatformError,
  platformEvents,
} from "@starter/shared/platform";
import type {
  CreateTenantInput,
  Outlet,
  OutletRestoreWindow,
  RestoreOutletInput,
  RestoreTenantInput,
  SetTenantPackageInput,
  SetTenantStatusInput,
  Tenant,
  TenantRestoreWindow,
  PlatformPackage,
  PackageKey,
} from "@starter/shared/platform";
import {
  canRestoreFrom,
  canTransitionTenant,
  modulesOutsidePackage,
  outletRestoreStatusSchema,
  outletRestoreWindowSchema,
  platformPackageSchema,
  restoreDeadline,
  tenantRestoreStatusSchema,
  tenantRestoreWindowSchema,
  tenantSchema,
} from "@starter/shared/platform";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { TenantStatus } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  edgeNodes,
  outlets,
  paymentRoutingRules,
  platformPackages,
  tenants,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { seedTenantRoleTemplates } from "./access.service.ts";
import { recordAudit } from "./audit-writer.ts";
import { appendOutbox } from "./core-outbox.ts";
import { toOutlet } from "./org.service.ts";
import { provisionStandardUoms } from "./inventory-provisioning.service.ts";
import { provisionFirstTenantAdmin } from "./platform-admin-provision.service.ts";
import {
  isPlatformGatewayEnabled,
  platformDefaultGateway,
} from "./platform-payment-gateway.service.ts";
import { provisionLoyaltyDefaults } from "./loyalty-provisioning.service.ts"; // legend-111j
import {
  provisionDefaultServiceChargeRule,
  provisionDefaultTaxConfig,
} from "./tax-provisioning.service.ts";

type TenantRow = typeof tenants.$inferSelect;
type PackageRow = typeof platformPackages.$inferSelect;

function toTenant(row: TenantRow): Tenant {
  return tenantSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan,
    status: row.status,
    deploymentMode: row.deploymentMode,
    featureFlags: row.featureFlags,
    limits: row.limits,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}

function toPackage(row: PackageRow): PlatformPackage {
  return platformPackageSchema.parse({
    key: row.key,
    name: row.name,
    modules: row.modules,
    defaultLimits: row.defaultLimits,
    status: row.status,
  });
}

/** Package catalog for the panel (assigning a plan needs the list). */
export async function listPackages(): Promise<{ data: PlatformPackage[] }> {
  const rows = await db
    .select()
    .from(platformPackages)
    .orderBy(platformPackages.key);
  return { data: rows.map(toPackage) };
}

/** The package must exist and be assignable; retired packages are refused. */
async function assignablePackage(key: PackageKey): Promise<PlatformPackage> {
  const [row] = await db
    .select()
    .from(platformPackages)
    .where(eq(platformPackages.key, key))
    .limit(1);
  if (!row || row.status !== "active")
    throw new HttpError(422, "VALIDATION_ERROR", "Unknown or retired package.");
  return toPackage(row);
}

export async function listTenants(query: {
  limit: number;
  cursor?: string;
  status?: TenantStatus;
  q?: string;
}): Promise<{
  data: Tenant[];
  meta: { limit: number; nextCursor: string | null };
}> {
  const filters = [];
  if (query.status) filters.push(eq(tenants.status, query.status));
  if (query.q) {
    const pattern = `%${query.q.replaceAll(/[%_\\]/g, "\\$&")}%`;
    filters.push(
      or(ilike(tenants.name, pattern), ilike(tenants.slug, pattern)),
    );
  }
  if (query.cursor) {
    const [createdAt, id] = decodeCursor(query.cursor);
    if (typeof createdAt !== "string" || typeof id !== "string")
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    filters.push(
      or(
        lt(tenants.createdAt, new Date(createdAt)),
        and(eq(tenants.createdAt, new Date(createdAt)), lt(tenants.id, id)),
      ),
    );
  }
  const rows = await db
    .select()
    .from(tenants)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(tenants.createdAt), desc(tenants.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(toTenant),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    },
  };
}

export async function getTenantOrThrow(tenantId: string): Promise<Tenant> {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return toTenant(row);
}

/** Consumers receive platform events through the cloud sync stream. */
const EVENT_DESTINATION = "cloud-sync";

/**
 * Tenant-wide context for a platform action on `tenantId`. The id is chosen by
 * the platform action (a new tenant, or a route parameter behind the platform
 * permission), never resolved from a client tenant parameter (TEN-02). Audit
 * rows land in that tenant's audit_logs under RLS, where its admin sees them
 * (TEN-04: Super Admin actions are visible to the tenant).
 */
function platformTenantScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/**
 * TEN-06 / flow R steps 2-3: a tenant is created from panel input, active from
 * the start, with its 17 tenant-level role templates (PRD §3.7, legend-4f9)
 * and its first admin (legend-2ign): an identity account (reused or invited,
 * see platform-admin-provision.service.ts) holding the tenant_admin template
 * at tenant scope. The tenant, templates, account, assignment, audit rows and
 * the `tenant.created` outbox event (which names the admin, so the
 * notification side can send the invitation) commit together or not at all.
 * Nothing secret is created or returned: the admin signs in with the WhatsApp
 * reverse OTP or an email magic link.
 *
 * Minting the context for the id before the row exists is safe (TEN-02: the
 * platform action chose it, never a client parameter).
 */
export async function createTenant(
  input: CreateTenantInput,
  actorUserId: string,
  now = new Date(),
): Promise<Tenant> {
  const pkg = await assignablePackage(input.plan);
  const outside = modulesOutsidePackage(input.featureFlags.modules, pkg);
  if (outside.length > 0) throw new PlatformError("MODULE_NOT_IN_PACKAGE");

  // Sub-302 D8: a new tenant gets the platform default gateway unless Super
  // Admin already listed a payment gateway for it. Changing the default later
  // never touches an existing tenant (PAY-05).
  const platformDefault = await platformDefaultGateway();
  const listed = input.featureFlags.integrationProviders.filter((provider) =>
    (PAYMENT_GATEWAY_PROVIDERS as readonly string[]).includes(provider),
  );
  const featureFlags =
    platformDefault && listed.length === 0
      ? {
          ...input.featureFlags,
          integrationProviders: [
            ...input.featureFlags.integrationProviders,
            platformDefault as (typeof PAYMENT_GATEWAY_PROVIDERS)[number],
          ],
        }
      : input.featureFlags;
  // Rules go on the platform default only if the tenant lists it; otherwise on
  // the first listed gateway Super Admin has switched on; none -> no rules.
  const tenantGateways = featureFlags.integrationProviders.filter((provider) =>
    (PAYMENT_GATEWAY_PROVIDERS as readonly string[]).includes(provider),
  );
  let defaultGateway: (typeof PAYMENT_GATEWAY_PROVIDERS)[number] | null = null;
  if (platformDefault && tenantGateways.includes(platformDefault as never))
    defaultGateway =
      platformDefault as (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
  else
    for (const provider of tenantGateways)
      if (await isPlatformGatewayEnabled(provider)) {
        defaultGateway = provider as (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
        break;
      }

  const tenantId = randomUUID();
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(tenants)
      .values({
        id: tenantId,
        slug: input.slug,
        name: input.name,
        plan: input.plan,
        deploymentMode: input.deploymentMode,
        featureFlags,
        limits: input.limits,
        createdBy: actorUserId,
      })
      .onConflictDoNothing({ target: tenants.slug })
      .returning();
    if (!row)
      throw new HttpError(
        409,
        "CONFLICT",
        "That tenant slug is already taken.",
      );
    await seedTenantRoleTemplates(tx, row.id);
    // Tenant-wide online-method rules on the default gateway, same transaction.
    if (defaultGateway)
      await tx.insert(paymentRoutingRules).values(
        (["qris", "va", "bank_transfer"] as const).map((method) => ({
          tenantId: context.tenant.tenantId,
          outletId: null,
          method,
          provider: defaultGateway,
          fallbackProvider: null,
          enabled: true,
          updatedBy: actorUserId,
        })),
      );
    // Standard UOM catalog, same transaction (PRD v1.7 §3.19, legend-4ryw).
    const actor = userIdSchema.safeParse(actorUserId);
    await provisionStandardUoms(tx, context, actor.success ? actor.data : null);
    // Default PBJT rule + exclusive tax settings, same transaction, so the
    // tenant can price orders at once (legend-9obf, founder decision Q13).
    await provisionDefaultTaxConfig(
      tx,
      context,
      actor.success ? actor.data : null,
    );
    // Consent policy versions `2026-01`, same transaction (legend-111j).
    await provisionLoyaltyDefaults(tx, context);
    // Default 5% dine-in service charge, same transaction (legend-2qz7, Q25).
    await provisionDefaultServiceChargeRule(
      tx,
      context,
      actor.success ? actor.data : null,
      null,
    );
    const admin = await provisionFirstTenantAdmin(
      tx,
      context,
      input.firstAdmin,
      { actorUserId, now },
    );

    const definition = platformEvents["tenant.created"];
    const event = definition.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId: null,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: tenantId,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: actorUserId },
      deviceId: null,
      idempotencyKey: `${definition.name}:${tenantId}:1`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: {
        slug: row.slug,
        plan: row.plan,
        modules: [...input.featureFlags.modules],
        firstAdminUserId: admin.userId,
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
    });

    // No name, number or email in the snapshot: the masker would redact them
    // anyway, and the admin is identified by account id (PRD §6 B audit_logs).
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "tenant.created",
        objectType: "tenant",
        objectId: tenantId,
        reason: null,
        before: null,
        after: {
          slug: row.slug,
          plan: row.plan,
          deploymentMode: row.deploymentMode,
          modules: [...input.featureFlags.modules],
          firstAdminUserId: admin.userId,
          adminProvisioning: admin.account,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toTenant(row);
  });
}

/**
 * Suspension is reversible. Archiving is final through this endpoint (contract
 * state machine) except for the platform restore within 30 days (Q40,
 * `restoreTenant`); archiving records when and from which status, so a restore
 * can return there.
 */
export async function setTenantStatus(
  tenantId: string,
  input: SetTenantStatusInput,
  actorUserId: string,
  now: Date = new Date(),
): Promise<Tenant> {
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    if (current.status === input.status) return toTenant(current);
    if (!canTransitionTenant(current.status, input.status))
      throw new PlatformError("INVALID_TRANSITION");
    const [row] = await tx
      .update(tenants)
      .set({
        status: input.status,
        ...(input.status === "archived"
          ? {
              archivedAt: now,
              statusBeforeArchive: tenantRestoreStatusSchema.parse(
                current.status,
              ),
            }
          : {}),
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "tenant.status_changed",
        objectType: "tenant",
        objectId: tenantId,
        reason: input.reason,
        before: { status: current.status },
        after: { status: row.status },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toTenant(row);
  });
}

/**
 * Q40 (legend-umzos): a Super Admin restores an archived tenant to the status
 * it had before archiving, within 30 days of archiving (deadline inclusive).
 * Legacy rows without a recorded archive time stay final.
 */
export async function restoreTenant(
  tenantId: string,
  input: RestoreTenantInput,
  actorUserId: string,
  now: Date = new Date(),
): Promise<Tenant> {
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    if (current.status !== "archived")
      throw new PlatformError(
        "RESTORE_NOT_AVAILABLE",
        "Tenant ini tidak berstatus diarsipkan.",
      );
    const check = canRestoreFrom(
      current.archivedAt,
      current.statusBeforeArchive,
      now,
    );
    if (!check.ok) throw new PlatformError(check.code);
    const [row] = await tx
      .update(tenants)
      .set({
        status: tenantRestoreStatusSchema.parse(current.statusBeforeArchive),
        archivedAt: null,
        statusBeforeArchive: null,
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "tenant.restored",
        objectType: "tenant",
        objectId: tenantId,
        reason: input.reason,
        before: {
          status: "archived",
          archivedAt: current.archivedAt?.toISOString() ?? null,
        },
        after: { status: row.status },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toTenant(row);
  });
}

/** Panel read model: can this tenant be restored, to what, until when. */
export async function getTenantRestoreWindow(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantRestoreWindow> {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  const check = canRestoreFrom(row.archivedAt, row.statusBeforeArchive, now);
  return tenantRestoreWindowSchema.parse({
    tenantId: row.id,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    restoreTo: row.statusBeforeArchive,
    restorableUntil: row.archivedAt
      ? restoreDeadline(row.archivedAt).toISOString()
      : null,
    restorable: row.status === "archived" && check.ok,
  });
}

/**
 * Q40: restores a closed outlet to its status before closing, within 30 days.
 * The tenant must not be archived (restore the tenant first). Edge credentials
 * were never revoked on close, so the outlet's edge nodes reconnect without
 * re-registration; the audit row counts the active ones.
 */
export async function restoreOutlet(
  tenantId: string,
  outletId: string,
  input: RestoreOutletInput,
  actorUserId: string,
  now: Date = new Date(),
): Promise<Outlet> {
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("update");
    if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    if (tenant.status === "archived")
      throw new PlatformError(
        "INVALID_TRANSITION",
        "Pulihkan tenant terlebih dahulu sebelum memulihkan outlet.",
      );
    const [current] = await tx
      .select()
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    if (current.status !== "closed")
      throw new PlatformError(
        "RESTORE_NOT_AVAILABLE",
        "Outlet ini tidak berstatus ditutup.",
      );
    const check = canRestoreFrom(
      current.closedAt,
      current.statusBeforeClose,
      now,
    );
    if (!check.ok) throw new PlatformError(check.code);
    const [row] = await tx
      .update(outlets)
      .set({
        status: outletRestoreStatusSchema.parse(current.statusBeforeClose),
        closedAt: null,
        statusBeforeClose: null,
      })
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .returning();
    const [edge] = await tx
      .select({ total: count() })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, tenantIdSchema.parse(tenantId)),
          eq(edgeNodes.outletId, outletIdSchema.parse(outletId)),
          eq(edgeNodes.status, "active"),
        ),
      );
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "outlet.restored",
        objectType: "outlet",
        objectId: outletId,
        reason: input.reason,
        before: {
          status: "closed",
          closedAt: current.closedAt?.toISOString() ?? null,
        },
        after: { status: row.status, activeEdgeNodes: edge?.total ?? 0 },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toOutlet(row);
  });
}

/** Panel read model for a closed outlet. Needs the tenant not archived. */
export async function getOutletRestoreWindow(
  tenantId: string,
  outletId: string,
  now: Date = new Date(),
): Promise<OutletRestoreWindow> {
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    const [row] = await tx
      .select()
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    const check = canRestoreFrom(row.closedAt, row.statusBeforeClose, now);
    return outletRestoreWindowSchema.parse({
      tenantId,
      outletId,
      status: row.status,
      closedAt: row.closedAt?.toISOString() ?? null,
      restoreTo: row.statusBeforeClose,
      restorableUntil: row.closedAt
        ? restoreDeadline(row.closedAt).toISOString()
        : null,
      restorable:
        row.status === "closed" && check.ok && tenant.status !== "archived",
    });
  });
}

/** Assigns a package + flags + quotas; flags may not exceed the package. */
export async function setTenantPackage(
  tenantId: string,
  input: SetTenantPackageInput,
  actorUserId: string,
): Promise<Tenant> {
  const pkg = await assignablePackage(input.plan);
  const outside = modulesOutsidePackage(input.featureFlags.modules, pkg);
  if (outside.length > 0) throw new PlatformError("MODULE_NOT_IN_PACKAGE");
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    const [row] = await tx
      .update(tenants)
      .set({
        plan: input.plan,
        featureFlags: input.featureFlags,
        limits: input.limits,
      })
      .where(eq(tenants.id, tenantId))
      .returning();
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "tenant.package_changed",
        objectType: "tenant",
        objectId: tenantId,
        reason: input.reason,
        before: {
          plan: current.plan,
          modules: [...current.featureFlags.modules],
          limits: { ...current.limits },
        },
        after: {
          plan: row.plan,
          modules: [...row.featureFlags.modules],
          limits: { ...row.limits },
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toTenant(row);
  });
}

/**
 * TEN-05 fail-closed read: the tenant's flags for the API module gate. A
 * missing tenant yields null, and `assertModuleEnabled` treats null as off.
 */
export async function tenantFeatureFlags(tenantId: string) {
  const [row] = await db
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.featureFlags ?? null;
}
