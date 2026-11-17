// Shared helpers for the TL-07..TL-12 / TL-20 handlers (bead legend-ktqc).
import { eq, sql, type SQL } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  AiError,
  getAiTool,
  TOOL_MAX_ROWS,
  type AiToolCode,
  type ToolPeriod,
} from "@starter/shared/ai";
import { type ScopedTenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../../../db/index.ts";
import { outlets } from "../../../db/schema/platform-org.ts";
import { withTenant } from "../../../db/tenant.ts";
import { callerToolMatches } from "../../ai-metrics/scope.ts";
import type { AiToolContext } from "../types.ts";

export { TOOL_MAX_ROWS };

export const forbidden = (): AiError => new AiError("AI_TOOL_FORBIDDEN");

export type ToolReach = {
  /** Server-minted RLS context for `withTenant`. */
  readonly context: ScopedTenantContext;
  /** Lower-case outlet ids the caller reaches; null = every outlet of the tenant. */
  readonly outletIds: readonly string[] | null;
};

const lower = (value: string) => value.toLowerCase();

/** Outlets of the tenant, read on a tenant-wide context only to probe reach. */
async function tenantOutletIds(ctx: AiToolContext): Promise<string[]> {
  const probe = establishScopedTenantContext(ctx.access.tenant, {
    kind: "tenant",
  });
  const rows = await withTenant(db, probe, (tx) =>
    tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, ctx.access.tenant.tenantId)),
  );
  return rows.map((row) => lower(row.id));
}

/**
 * Template keys through which the caller may use tool `code`: the tool's
 * `minRoles` entries the caller actively holds whose permission set (override
 * included) they hold. Same rule as `toolMatches`; the data permission is then
 * checked per key with `allowsVia`.
 */
function viaTemplates(ctx: AiToolContext, code: AiToolCode): string[] {
  const tool = getAiTool(code);
  if (!tool) throw new RangeError(`Unknown tool ${code}`);
  return callerToolMatches(ctx.access, tool).map((match) => match.role);
}

/**
 * Reach of the caller for one permission, or null when the caller does not
 * hold it anywhere. The context always comes from `access.contextFor`; the
 * outlet list is probed per outlet, so only the caller's own snapshot decides.
 * With a tool `code`, a target counts only when an assignment of a template
 * that qualifies for that tool (`allowsVia`) allows it, so an
 * assignment of another role cannot widen a role-specific grant. The RLS
 * context may be wider than that; `outletIds` carries the narrower reach.
 */
export async function tryResolveReach(
  ctx: AiToolContext,
  permission: PermissionCode,
  code?: AiToolCode,
): Promise<ToolReach | null> {
  const via = code === undefined ? null : viaTemplates(ctx, code);
  if (via !== null && via.length === 0) return null;
  const holds = (target: Parameters<typeof ctx.access.allows>[1]) =>
    via === null
      ? ctx.access.allows(permission, target)
      : via.some((key) => ctx.access.allowsVia(key, permission, target));
  const wide = holds({ type: "tenant" })
    ? ctx.access.contextFor(permission, { type: "tenant" })
    : null;
  if (wide) {
    return {
      context: wide,
      outletIds:
        wide.outletScope.kind === "tenant"
          ? null
          : wide.outletScope.outletIds.map(lower),
    };
  }
  if (!ctx.access.permissions.includes(permission)) return null;
  const reachable: string[] = [];
  for (const id of await tenantOutletIds(ctx))
    if (holds({ type: "outlet", id })) reachable.push(id);
  const first = reachable[0];
  if (first === undefined) return null;
  const context = ctx.access.contextFor(permission, {
    type: "outlet",
    id: first,
  });
  if (!context) return null;
  return {
    context,
    outletIds:
      context.outletScope.kind === "tenant"
        ? reachable
        : reachable.filter((id) =>
            (context.outletScope as { outletIds: readonly string[] }).outletIds
              .map(lower)
              .includes(id),
          ),
  };
}

export async function resolveReach(
  ctx: AiToolContext,
  permission: PermissionCode,
  code?: AiToolCode,
): Promise<ToolReach> {
  const reach = await tryResolveReach(ctx, permission, code);
  if (!reach) throw forbidden();
  return reach;
}

/**
 * Intersects the optional outlet filter of the input with the caller's reach.
 * An outlet outside the reach is denied, never silently dropped (TEN-03).
 * Returns null when no filter applies (whole tenant reach, no filter).
 */
export function scopeOutlets(
  reach: ToolReach,
  requested: readonly string[] | undefined,
): string[] | null {
  if (requested === undefined || requested.length === 0)
    return reach.outletIds === null ? null : [...reach.outletIds];
  const wanted = [...new Set(requested.map(lower))];
  if (reach.outletIds !== null) {
    const allowed = new Set(reach.outletIds);
    if (wanted.some((id) => !allowed.has(id))) throw forbidden();
  }
  return wanted;
}

/** `a::uuid, b::uuid` list for an `IN (...)` clause. */
export function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** `and <column> in (...)`, or nothing when no outlet filter applies. */
export function outletClause(column: SQL, outletIds: string[] | null): SQL {
  if (outletIds === null) return sql``;
  // An empty list matches no row.
  if (outletIds.length === 0) return sql`and false`;
  return sql`and ${column} in (${uuidList(outletIds)})`;
}

/**
 * Denies an outlet filter that names an outlet which is not this tenant's.
 * A whole-tenant reach does not list outlet ids, so scopeOutlets cannot tell a
 * foreign outlet from an empty one; this check runs inside the tenant
 * transaction. No-op without an input filter.
 */
export async function assertKnownOutlets(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  requested: readonly string[] | undefined,
  wanted: string[] | null,
): Promise<void> {
  if (requested === undefined || wanted === null || wanted.length === 0) return;
  const known = (
    await tx.execute(sql`
      select count(*)::int as n from outlets o
      where o.tenant_id = ${tenantId}::uuid
      ${outletClause(sql`o.id`, wanted)}
    `)
  ).rows[0] as { n: number } | undefined;
  if (Number(known?.n ?? 0) !== wanted.length) throw forbidden();
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

export function daysInPeriod(period: ToolPeriod): number {
  return (
    (Date.parse(`${period.to}T00:00:00Z`) -
      Date.parse(`${period.from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/** A one-day period for sources of tools that have no period input. */
export function todayPeriod(now: Date): ToolPeriod {
  const today = now.toISOString().slice(0, 10);
  return { from: today, to: today } as ToolPeriod;
}
