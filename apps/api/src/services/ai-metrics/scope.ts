// Access + period helpers shared by the read tools (WS-12 part R-A, bead
// legend-mfyo). Every decision comes from the caller's `AccessSnapshot`:
// the role (template key) must be one of the tool's `minRoles`, the role's
// permission set must be held THROUGH THAT ROLE's own assignments
// (`permissionsVia` / `allowsVia`, never the union of all roles), and the RLS
// context is minted only by `access.contextFor`. The LLM never supplies a
// tenant or a wider outlet reach.
import { eq, and } from "drizzle-orm";
import {
  isOutletInScope,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { PermissionCode } from "@starter/shared/access";
import {
  AiError,
  getAiTool,
  requiredPermissionsFor,
  TOOL_MAX_OUTLET_FILTER,
} from "@starter/shared/ai";
import type {
  AiToolAccessLevel,
  AiToolCode,
  AiToolDefinition,
  ToolPeriod,
} from "@starter/shared/ai";
import {
  metricSourceReportPath,
  type MetricFinality,
} from "@starter/shared/metrics";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import { outlets } from "../../db/schema";
import type { AccessSnapshot } from "../permission-resolver.ts";
import type { AiToolContext } from "../ai-tools/types.ts";

/** One way the caller qualifies for a tool: a minRoles entry they hold. */
export type ToolMatch = {
  readonly role: string;
  readonly access: AiToolAccessLevel;
  /** ALL-of permissions for this role (role override or tool default). */
  readonly permissions: readonly PermissionCode[];
};

export type OutletRef = { readonly id: string; readonly name: string };

export type OutletReadScope = {
  readonly context: ScopedTenantContext;
  /** Outlets the query covers: requested ∩ permitted, never wider. */
  readonly outlets: readonly OutletRef[];
  readonly matches: readonly ToolMatch[];
};

const forbidden = () => new AiError("AI_TOOL_FORBIDDEN");

/**
 * minRoles entries whose role the caller holds AND whose permissions they hold
 * through assignments of that same role. The one rule for listing, invoking
 * and running a tool (custom roles outside `minRoles` never qualify).
 */
export function callerToolMatches(
  access: AccessSnapshot,
  tool: AiToolDefinition,
): ToolMatch[] {
  const matches: ToolMatch[] = [];
  for (const entry of tool.minRoles) {
    if (!access.templateKeys.includes(entry.role)) continue;
    const held = new Set<string>(access.permissionsVia(entry.role));
    const permissions = requiredPermissionsFor(tool, entry.role);
    if (!permissions.every((code) => held.has(code))) continue;
    matches.push({ role: entry.role, access: entry.access, permissions });
  }
  return matches;
}

/** `callerToolMatches` for a tool code; AI_TOOL_FORBIDDEN when none. */
export function toolMatches(ctx: AiToolContext, code: AiToolCode): ToolMatch[] {
  const tool = getAiTool(code);
  if (!tool) throw new RangeError(`Unknown tool ${code}`);
  const matches = callerToolMatches(ctx.access, tool);
  if (matches.length === 0) throw forbidden();
  return matches;
}

/** The match's whole permission set holds at `target` via its own role. */
function matchAllows(
  access: AccessSnapshot,
  match: ToolMatch,
  target: Parameters<AccessSnapshot["allowsVia"]>[2],
): boolean {
  return match.permissions.every((permission) =>
    access.allowsVia(match.role, permission, target),
  );
}

/**
 * Outlet id + name of the tenant (organisation metadata only, no operational
 * rows). `outlets` carries tenant RLS only, so a tenant-wide read context is
 * enough; what the caller may see of each outlet is decided afterwards by
 * `access.allows`, and every data query runs in a `contextFor` context.
 */
async function listTenantOutlets(ctx: AiToolContext): Promise<OutletRef[]> {
  const { tenant } = ctx.access;
  const discovery = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, discovery, (tx) =>
    tx
      .select({ id: outlets.id, name: outlets.name })
      .from(outlets)
      .where(
        tenant.brandId === null
          ? eq(outlets.tenantId, tenant.tenantId)
          : and(
              eq(outlets.tenantId, tenant.tenantId),
              eq(outlets.brandId, tenant.brandId),
            ),
      )
      .orderBy(outlets.name, outlets.id),
  );
}

const lower = (value: string) => value.toLowerCase();

/**
 * Outlets the caller may read through `code`. With `requested`, every id must
 * be permitted, else AI_TOOL_FORBIDDEN (no silent narrowing, no leak). Without
 * it, all permitted outlets.
 */
export async function resolveOutletScope(
  ctx: AiToolContext,
  code: AiToolCode,
  requested: readonly string[] | undefined,
): Promise<OutletReadScope> {
  const matches = toolMatches(ctx, code);
  const { access } = ctx;
  const allowedBy = (outletId: string) =>
    matches.some((match) =>
      matchAllows(access, match, { type: "outlet", id: outletId }),
    );
  const all = await listTenantOutlets(ctx);
  const permitted = all.filter((outlet) => allowedBy(outlet.id));
  let selected: OutletRef[];
  if (requested !== undefined && requested.length > 0) {
    const ids = [...new Set(requested.map(lower))];
    if (ids.length > TOOL_MAX_OUTLET_FILTER) throw forbidden();
    selected = [];
    for (const id of ids) {
      const found = permitted.find((outlet) => lower(outlet.id) === id);
      if (!found) throw forbidden();
      selected.push(found);
    }
  } else {
    selected = permitted;
  }
  if (selected.length === 0) throw forbidden();
  // One RLS context serves the whole query, so it must reach EVERY selected
  // outlet; a context that silently drops an outlet (granted through another
  // role or permission) would under-report while claiming full coverage.
  // Try each grant's permissions; none covers all -> AI_TOOL_FORBIDDEN (the
  // caller can still ask per outlet).
  for (const match of matches) {
    for (const permission of match.permissions) {
      const context = access.contextFor(permission, {
        type: "outlet",
        id: selected[0]!.id,
      });
      if (
        context &&
        selected.every((outlet) =>
          isOutletInScope(context.outletScope, outlet.id),
        )
      )
        return { context, outlets: selected, matches };
    }
  }
  throw forbidden();
}

/**
 * Tenant-level tools (finance): the caller must hold one role's set at tenant
 * scope through that role. `match` is the grant that minted the context; its
 * access level (e.g. closed_period_aggregate) is what the handler must apply,
 * never a level carried by another role held at a narrower scope. A full
 * (non-aggregate) grant wins over an aggregate-only one.
 */
export function resolveTenantScope(
  ctx: AiToolContext,
  code: AiToolCode,
): {
  context: ScopedTenantContext;
  match: ToolMatch;
  matches: readonly ToolMatch[];
} {
  const matches = toolMatches(ctx, code);
  const atTenant = matches.filter((entry) =>
    matchAllows(ctx.access, entry, { type: "tenant" }),
  );
  const match =
    atTenant.find((entry) => entry.access !== "closed_period_aggregate") ??
    atTenant[0];
  const permission = match?.permissions[0];
  if (!match || !permission) throw forbidden();
  const context = ctx.access.contextFor(permission, { type: "tenant" });
  if (!context) throw forbidden();
  return { context, match, matches };
}

/** True when the caller holds `permission` at every listed outlet. */
export function holdsAtAll(
  ctx: AiToolContext,
  permission: PermissionCode,
  outletList: readonly OutletRef[],
): boolean {
  return (
    outletList.length > 0 &&
    outletList.every((outlet) =>
      ctx.access.allows(permission, { type: "outlet", id: outlet.id }),
    )
  );
}

// ---- Period + source helpers ----------------------------------------------

const JAKARTA_OFFSET_MS = 7 * 3_600_000;

/** Today's business date (YYYY-MM-DD) in the cafe timezone (WIB). */
export function todayBusinessDate(now: Date): string {
  return new Date(now.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Live numbers are final once the whole period lies before today. */
export function liveFinality(period: ToolPeriod, now: Date): MetricFinality {
  return period.to < todayBusinessDate(now) ? "final" : "estimate";
}

/** YYYY-MM of every calendar month the period touches. */
export function monthsOf(period: ToolPeriod): string[] {
  const months: string[] = [];
  let year = Number(period.from.slice(0, 4));
  let month = Number(period.from.slice(5, 7));
  const last = period.to.slice(0, 7);
  for (let guard = 0; guard < 14; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const MAX_LINK = 500;

/** App-relative report link with the standard period + outlet query keys. */
export function reportLink(
  route: string,
  period: ToolPeriod,
  outletIds: readonly string[] = [],
): string {
  const source = { reportCode: route, route };
  const full = metricSourceReportPath(source, {
    startDate: period.from,
    endDate: period.to,
    outletIds,
  });
  if (full.length <= MAX_LINK) return full;
  return metricSourceReportPath(source, {
    startDate: period.from,
    endDate: period.to,
  });
}
