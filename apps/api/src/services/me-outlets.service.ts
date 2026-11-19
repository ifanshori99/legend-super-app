// Outlets assigned to the signed-in account (bead legend-ebt9f; PRD v1.7 §3.7
// RBAC outlet scope, §5 "Peta situs" ops area).
//
// The staff web app builds its outlet context and picker from this list
// (GET /api/me/access). The reach comes only from the caller's own stored
// assignments, never from request input (TEN-02). A tenant-scoped assignment
// reaches every outlet of the (brand-pinned) tenant, a brand-scoped one the
// brand's outlets, an outlet-scoped one that outlet. A station-scoped
// assignment contributes its station's outlet: the person works at that
// outlet, and every station-bound request still re-asserts the station itself.
// Presentation data only: each API request is authorized again against its own
// outlet. Closed outlets are not offered.

import {
  isAssignmentActive,
  outletReachOf,
  myOutletSchema,
  type MyOutlet,
} from "@starter/shared/access";
import { userIdSchema, type TenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";
import { outlets } from "../db/schema";
import { withTenant } from "../db/tenant";
import type { TenantAccessData } from "./permission-resolver";

export function assignedOutletIds(input: {
  readonly tenant: TenantContext;
  readonly userId: string;
  readonly data: TenantAccessData;
  readonly now: Date;
}): string[] {
  const { data } = input;
  // The DB clock of the load wins over the caller's `now` (bead 1201).
  const now = data.clock ?? input.now;
  const userId = userIdSchema.parse(input.userId);
  const principal = {
    tenantId: input.tenant.tenantId,
    userId,
    assignments: data.assignments,
  } as const;
  const reach = outletReachOf({
    principal,
    roles: data.roles,
    org: data.org,
    now,
  });
  if (reach?.kind === "tenant")
    return data.org.outlets.map((outlet) => outlet.id);
  const ids = new Set<string>(reach?.outletIds ?? []);
  // Station-only assignments: the station's outlet (known roles only).
  const knownRoles = new Set(data.roles.map((role) => role.id.toLowerCase()));
  for (const assignment of data.assignments) {
    if (
      assignment.scope.type !== "station" ||
      assignment.userId.toLowerCase() !== userId.toLowerCase() ||
      assignment.tenantId.toLowerCase() !==
        input.tenant.tenantId.toLowerCase() ||
      !knownRoles.has(assignment.roleId.toLowerCase()) ||
      !isAssignmentActive(assignment, now)
    )
      continue;
    const station = data.org.stations.find(
      (row) => row.id.toLowerCase() === assignment.scope.id?.toLowerCase(),
    );
    if (station) ids.add(station.outletId.toLowerCase());
  }
  return [...ids];
}

// Fixed collation for the visible outlet list: the database collation (C or
// ICU) varies per install, so the order is applied here, not in SQL.
const outletNameCollator = new Intl.Collator("id", {
  numeric: true,
  sensitivity: "base",
});

/** Outlet order of the picker: name (fixed collation), then id. */
export function compareOutlets(
  a: { readonly name: string; readonly id: string },
  b: { readonly name: string; readonly id: string },
): number {
  return (
    outletNameCollator.compare(a.name, b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The caller's assigned, non-closed outlets, sorted by name then id. */
export async function listMyOutlets(input: {
  readonly tenant: TenantContext;
  readonly userId: string;
  readonly data: TenantAccessData;
  readonly now: Date;
}): Promise<MyOutlet[]> {
  const ids = assignedOutletIds(input);
  if (ids.length === 0) return [];
  const context = establishScopedTenantContext(input.tenant, {
    kind: "outlets",
    outletIds: ids as never,
  });
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: outlets.id,
        name: outlets.name,
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, input.tenant.tenantId),
          inArray(outlets.id, ids),
          ne(outlets.status, "closed"),
        ),
      )
      .orderBy(asc(outlets.id)),
  );
  // One outlet row with bad data (for example a broken time zone) must not
  // fail the whole access view: the caller would lose every permission. Drop
  // the row and log it.
  const valid: MyOutlet[] = [];
  for (const row of rows) {
    const parsed = myOutletSchema.safeParse({
      id: row.id,
      name: row.name,
      timeZone: row.timezone,
      businessDayCutoff: row.businessDayCutoff,
    });
    if (parsed.success) valid.push(parsed.data);
    else
      logger.warn(
        { outletId: row.id, issues: parsed.error.issues.map((i) => i.path) },
        "me/access: outlet skipped, invalid stored data",
      );
  }
  return valid.sort(compareOutlets);
}
