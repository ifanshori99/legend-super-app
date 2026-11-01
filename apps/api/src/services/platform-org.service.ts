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

import { and, desc, eq, ilike, lt, or } from "drizzle-orm";
import { PlatformError } from "@starter/shared/platform";
import type {
  CreateTenantInput,
  SetTenantPackageInput,
  SetTenantStatusInput,
  Tenant,
  PlatformPackage,
  PackageKey,
} from "@starter/shared/platform";
import {
  canTransitionTenant,
  modulesOutsidePackage,
  platformPackageSchema,
  tenantSchema,
} from "@starter/shared/platform";
import { decodeCursor, encodeCursor } from "@starter/shared/core";
import type { TenantStatus } from "@starter/shared/platform";
import { db } from "../db";
import { platformPackages, tenants } from "../db/schema";
import { HttpError } from "../lib/http-error";

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

/**
 * TEN-06: a tenant is created from panel input, active from the start.
 * The first-admin appointment (createTenantInput.firstAdmin) belongs to the
 * identity/RBAC beads: it needs the `users`/user_identities tables and a role
 * assignment, neither of which exists yet. The requested admin is validated
 * with the rest of the body and deliberately not turned into a stub row.
 */
export async function createTenant(
  input: CreateTenantInput,
  actorUserId: string,
): Promise<Tenant> {
  const pkg = await assignablePackage(input.plan);
  const outside = modulesOutsidePackage(input.featureFlags.modules, pkg);
  if (outside.length > 0) throw new PlatformError("MODULE_NOT_IN_PACKAGE");

  const [row] = await db
    .insert(tenants)
    .values({
      slug: input.slug,
      name: input.name,
      plan: input.plan,
      deploymentMode: input.deploymentMode,
      featureFlags: input.featureFlags,
      limits: input.limits,
      createdBy: actorUserId,
    })
    .onConflictDoNothing({ target: tenants.slug })
    .returning();
  if (!row)
    throw new HttpError(409, "CONFLICT", "That tenant slug is already taken.");
  return toTenant(row);
}

/** Suspension is reversible, archiving is final (contract state machine). */
export async function setTenantStatus(
  tenantId: string,
  input: SetTenantStatusInput,
): Promise<Tenant> {
  return db.transaction(async (tx) => {
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
      .set({ status: input.status })
      .where(eq(tenants.id, tenantId))
      .returning();
    return toTenant(row);
  });
}

/** Assigns a package + flags + quotas; flags may not exceed the package. */
export async function setTenantPackage(
  tenantId: string,
  input: SetTenantPackageInput,
): Promise<Tenant> {
  const pkg = await assignablePackage(input.plan);
  const outside = modulesOutsidePackage(input.featureFlags.modules, pkg);
  if (outside.length > 0) throw new PlatformError("MODULE_NOT_IN_PACKAGE");
  const [row] = await db
    .update(tenants)
    .set({
      plan: input.plan,
      featureFlags: input.featureFlags,
      limits: input.limits,
    })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return toTenant(row);
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
