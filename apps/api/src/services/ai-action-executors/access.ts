// Access rule for write tools, shared by the proposal (caller's snapshot) and
// the execution (requester's snapshot re-read at execution time). The rule is
// evaluated per role: an assignment of one role at one target never satisfies
// another role's permission set (`allowsVia`), so kitchen_lead@A + cashier@B is
// never read as kitchen_lead at B.
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  getAiTool,
  requiredPermissionsFor,
  type AiToolCode,
} from "@starter/shared/ai";
import { parseDecimal4 } from "@starter/shared/core";
import type { AccessSnapshot } from "../permission-resolver.ts";

/**
 * A ban blocks while it is open-ended or its `banExpires` is still in the
 * future. Shared by MCP authentication and action execution so both agree.
 */
export function isBanActive(
  banned: boolean | null | undefined,
  banExpires: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return (
    Boolean(banned) && (!banExpires || banExpires.getTime() > now.getTime())
  );
}

export function outletIdsOf(payload: Record<string, unknown>): string[] {
  if (typeof payload.outletId === "string") return [payload.outletId];
  if (Array.isArray(payload.outletIds))
    return [...new Set(payload.outletIds as string[])];
  return [];
}

/**
 * TL-14 changes stock, so `inventory.stock.view` is not enough: a decrease
 * needs a permission that removes stock (stock count or waste), an increase one
 * that adds it (stock count or receiving). TL-13 needs `purchasing.order.create`
 * as the manual purchase order screen does. Other tools' write permission
 * (promo.manage, menu.price.manage, menu.availability.toggle, hr.schedule.manage)
 * is already in their catalog `requiredPermissions`.
 */
function domainWriteHeld(
  via: (permission: PermissionCode) => boolean,
  toolCode: AiToolCode,
  payload: Record<string, unknown>,
): boolean {
  // TL-13 drafts a purchase order: the order itself needs `purchasing.order.create`,
  // as the manual screen does (the catalog roles already exclude kitchen_lead).
  if (toolCode === "TL-13") return via("purchasing.order.create");
  if (toolCode !== "TL-14") return true;
  const lines = Array.isArray(payload.lines)
    ? (payload.lines as { qtyDelta?: unknown }[])
    : [];
  const needsDecrease = lines.some(
    (l) => parseDecimal4(String(l.qtyDelta)) < 0n,
  );
  const needsIncrease = lines.some(
    (l) => parseDecimal4(String(l.qtyDelta)) > 0n,
  );
  const decrease =
    via("inventory.opname.count") || via("inventory.waste.record");
  const increase =
    via("inventory.opname.count") || via("inventory.stock.receive");
  return (!needsDecrease || decrease) && (!needsIncrease || increase);
}

/** Targets a payload touches: its outlets, or the tenant when it names none. */
export function targetsOf(payload: Record<string, unknown>): AccessTarget[] {
  const ids = outletIdsOf(payload);
  return ids.length === 0
    ? [{ type: "tenant" }]
    : ids.map((id) => ({ type: "outlet", id }));
}

/**
 * True when, at every target of the payload, the user holds one minRoles role
 * with all of its tool permissions, `ai.action.propose` and the domain write
 * permission, all through that same role. The role may differ per target
 * (GM at outlet A, owner at outlet B passes for a payload naming A and B):
 * each target is still fully covered by one role legitimately held there, and
 * permissions are never combined across roles at the same target. Accepted by
 * the CTO after Codex review 152 (legend-cy2e).
 */
export function holdsToolAccess(
  access: AccessSnapshot,
  toolCode: AiToolCode,
  payload: Record<string, unknown>,
): boolean {
  const tool = getAiTool(toolCode);
  if (!tool) return false;
  const entries = tool.minRoles.filter((entry) =>
    access.templateKeys.includes(entry.role),
  );
  return targetsOf(payload).every((target) =>
    entries.some((entry) => {
      const via = (permission: PermissionCode) =>
        access.allowsVia(entry.role, permission, target);
      return (
        requiredPermissionsFor(tool, entry.role).every(via) &&
        via("ai.action.propose") &&
        domainWriteHeld(via, toolCode, payload) &&
        // Promotions are tenant-wide records: the executor needs tenant-level
        // promo.manage, so the proposal asks for it too.
        (toolCode !== "TL-15" ||
          access.allowsVia(entry.role, "promo.manage", { type: "tenant" }))
      );
    }),
  );
}
