// Minimal names for operational inventory documents (legend-mgy0).
// Call only after authorizing the document at its outlet. This is deliberately
// not a directory: ids must come from rows already readable by the caller.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  inventoryStaffSchema,
  type InventoryStaff,
} from "@starter/shared/inventory";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { stations } from "../db/schema/menu.ts";
import { user } from "../db/schema/user.ts";
import type { Tx } from "./inventory-ops.shared.ts";

/** One batch per page/outlet, with only name + role selected from identity.
 * Previous assignments keep historical attribution readable after offboarding.
 * Future grants and cancelled empty windows do not establish outlet membership.
 */
export async function loadInventoryStaff(
  tx: Tx,
  tenantId: string,
  outletId: string,
  userIds: readonly (string | null)[],
  now = new Date(),
): Promise<Map<string, InventoryStaff>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const staff = new Map<string, InventoryStaff>();
  if (!ids.length) return staff;
  const rows = await tx
    .select({ userId: user.id, displayName: user.name, role: roles.name })
    .from(roleAssignments)
    .innerJoin(user, eq(user.id, roleAssignments.userId))
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .innerJoin(
      outlets,
      and(
        eq(outlets.tenantId, roleAssignments.tenantId),
        eq(outlets.id, outletId),
      ),
    )
    .leftJoin(
      stations,
      and(
        eq(stations.tenantId, roleAssignments.tenantId),
        eq(stations.id, roleAssignments.scopeId),
        isNull(stations.deletedAt),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        inArray(roleAssignments.userId, ids),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, roleAssignments.validFrom),
        ),
        or(
          eq(roleAssignments.scopeType, "tenant"),
          and(
            eq(roleAssignments.scopeType, "brand"),
            eq(roleAssignments.scopeId, outlets.brandId),
          ),
          and(
            eq(roleAssignments.scopeType, "outlet"),
            eq(roleAssignments.scopeId, outlets.id),
          ),
          and(
            eq(roleAssignments.scopeType, "station"),
            eq(stations.outletId, outlets.id),
          ),
        ),
      ),
    )
    .orderBy(
      // Prefer a current role; only fall back to former roles for offboarded staff.
      sql`CASE WHEN ${roleAssignments.validUntil} IS NULL OR ${roleAssignments.validUntil} > ${now} THEN 0 ELSE 1 END`,
      desc(roleAssignments.validFrom),
      asc(roles.name),
      asc(roleAssignments.id),
    );
  for (const row of rows) {
    if (staff.has(row.userId)) continue;
    const parsed = inventoryStaffSchema.safeParse(row);
    if (parsed.success) staff.set(row.userId, parsed.data);
  }
  return staff;
}
