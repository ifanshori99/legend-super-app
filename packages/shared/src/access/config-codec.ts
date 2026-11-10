// Config bundle section codecs for `roles` and `approval_policies` (TEN-09,
// bead legend-tct8). A codec turns tenant rows into tenant-free, key-addressed
// template items (toTemplate) and back into id-less drafts the importer
// inserts with freshly minted ids (fromTemplate). Structural, pure and
// browser-safe: the platform registry consumes these shapes, so nothing here
// imports from ../platform (avoids a cycle).
// - roles: super_admin is platform level and never exported. Template roles
//   keep their template key as item key; custom roles are namespaced
//   `custom.<slug>` so the two cannot collide.
// - approval_policies: the approver is a role *key*, never a role id, so the
//   section imports into a tenant whose role ids differ.

import { z } from "zod";
import { idrSchema } from "../core/index.ts";
import {
  APPROVAL_MAX_LEVELS,
  approvalActionTypeSchema,
  type ApprovalPolicy,
} from "./approval.ts";
import { tenantPermissionCodeSchema } from "./permissions.ts";
import { roleTemplateKeySchema, type Role } from "./schemas.ts";
import { scopeTypeSchema } from "./scope.ts";

/** Same shape as the bundle's generic item key (platform/config.ts). */
const ITEM_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const ITEM_KEY_MAX = 100;
const CUSTOM_ROLE_PREFIX = "custom.";
const CUSTOM_SLUG_MAX = 40;

const itemKeySchema = z.string().regex(ITEM_KEY_PATTERN);

export type ConfigDecodeResult<Draft> =
  { ok: true; drafts: Draft[] } | { ok: false; issues: string[] };

/** Return `base` or `base-2`, `base-3`... whichever is free, and reserve it. */
function uniqueKey(base: string, used: Set<string>): string {
  let candidate = base.slice(0, ITEM_KEY_MAX);
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `-${n}`;
    candidate = base.slice(0, ITEM_KEY_MAX - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function roleSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CUSTOM_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "role" : slug;
}

type RoleKeyRow = Pick<Role, "id" | "name" | "templateKey">;

/** Item keys of the exportable roles (super_admin skipped), in stable order. */
function assignRoleKeys<T extends RoleKeyRow>(
  rows: readonly T[],
): { row: T; key: string }[] {
  const used = new Set<string>();
  const out: { row: T; key: string }[] = [];
  // Stable order (templates first, then by name, then id) so the same
  // tenant always exports the same keys, whatever order the DB returns.
  const ordered = [...rows].sort(
    (a, b) =>
      Number(a.templateKey === null) - Number(b.templateKey === null) ||
      compareText(a.name, b.name) ||
      compareText(a.id, b.id),
  );
  for (const row of ordered) {
    if (row.templateKey === "super_admin") continue;
    const base =
      row.templateKey ?? `${CUSTOM_ROLE_PREFIX}${roleSlug(row.name)}`;
    out.push({ row, key: uniqueKey(base, used) });
  }
  return out;
}

/** roleId -> bundle item key, same algorithm as the roles codec. */
export function roleConfigKeys(
  rows: readonly RoleKeyRow[],
): Map<string, string> {
  return new Map(assignRoleKeys(rows).map(({ row, key }) => [row.id, key]));
}

// --- roles ------------------------------------------------------------------

const roleConfigItemSchema = z.strictObject({
  key: itemKeySchema,
  name: z.string().trim().min(1).max(100),
  templateKey: roleTemplateKeySchema.nullable(),
  permissions: z.array(tenantPermissionCodeSchema),
  allowedScopeTypes: z.array(scopeTypeSchema).min(1),
  mfaRequired: z.boolean(),
});
export type RoleConfigItem = z.infer<typeof roleConfigItemSchema>;
export type RoleConfigDraft = RoleConfigItem & { isTemplate: boolean };

export const rolesConfigCodec = {
  section: "roles" as const,
  version: 1 as const,
  itemSchema: roleConfigItemSchema,

  toTemplate(
    rows: readonly Pick<
      Role,
      | "id"
      | "name"
      | "templateKey"
      | "permissions"
      | "allowedScopeTypes"
      | "mfaRequired"
    >[],
  ): RoleConfigItem[] {
    return assignRoleKeys(rows).map(({ row, key }) => ({
      key,
      name: row.name,
      templateKey: row.templateKey,
      permissions: [...row.permissions],
      allowedScopeTypes: [...row.allowedScopeTypes],
      mfaRequired: row.mfaRequired,
    }));
  },

  fromTemplate(
    items: readonly RoleConfigItem[],
  ): ConfigDecodeResult<RoleConfigDraft> {
    const issues: string[] = [];
    const drafts: RoleConfigDraft[] = [];
    const names = new Map<string, string>();
    for (const raw of items) {
      const parsed = roleConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        const key = (raw as { key?: unknown } | null)?.key;
        issues.push(
          `roles item ${String(key)}: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "item"} ${i.message}`)
            .join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      const isCustomKey = item.key.startsWith(CUSTOM_ROLE_PREFIX);
      if (isCustomKey && item.templateKey !== null)
        issues.push(
          `roles item ${item.key}: custom key cannot carry a templateKey`,
        );
      else if (!isCustomKey && item.templateKey !== item.key)
        issues.push(
          `roles item ${item.key}: templateKey must equal the item key for a template role`,
        );
      else if (item.templateKey === "super_admin")
        issues.push(
          `roles item ${item.key}: super_admin templateKey is platform level and cannot be imported`,
        );

      const nameKey = item.name.trim().toLowerCase();
      const firstKey = names.get(nameKey);
      if (firstKey !== undefined)
        issues.push(
          `roles item ${item.key}: duplicate name "${item.name}" (also used by ${firstKey})`,
        );
      else names.set(nameKey, item.key);

      drafts.push({
        key: item.key,
        name: item.name,
        templateKey: item.templateKey,
        isTemplate: item.templateKey !== null,
        permissions: [...item.permissions],
        allowedScopeTypes: [...item.allowedScopeTypes],
        mfaRequired: item.mfaRequired,
      });
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
  },
};

// --- approval_policies ------------------------------------------------------

const approvalPolicyConfigItemSchema = z.strictObject({
  key: itemKeySchema,
  actionType: approvalActionTypeSchema,
  thresholdIdr: idrSchema
    .refine((value) => value >= 0, "thresholdIdr must be >= 0")
    .nullable(),
  levels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
  approverRoleKey: itemKeySchema,
  requiresDistinctActor: z.literal(true),
});
export type ApprovalPolicyConfigItem = z.infer<
  typeof approvalPolicyConfigItemSchema
>;
export type ApprovalPolicyConfigDraft = Omit<
  ApprovalPolicyConfigItem,
  "key"
> & { key: string };

export const approvalPoliciesConfigCodec = {
  section: "approval_policies" as const,
  version: 1 as const,
  itemSchema: approvalPolicyConfigItemSchema,

  toTemplate(
    rows: readonly Pick<
      ApprovalPolicy,
      | "actionType"
      | "thresholdIdr"
      | "levels"
      | "approverRoleId"
      | "requiresDistinctActor"
    >[],
    ctx: { roleKeyById: ReadonlyMap<string, string> },
  ): ApprovalPolicyConfigItem[] {
    const used = new Set<string>();
    const resolved = rows.map((row) => {
      const approverRoleKey = ctx.roleKeyById.get(row.approverRoleId);
      if (approverRoleKey === undefined)
        throw new Error(
          `approval_policies ${row.actionType}: approver role ${row.approverRoleId} has no exportable role key`,
        );
      return { row, approverRoleKey };
    });
    resolved.sort(
      (a, b) =>
        compareText(a.row.actionType, b.row.actionType) ||
        (a.row.thresholdIdr ?? -1) - (b.row.thresholdIdr ?? -1) ||
        a.row.levels - b.row.levels ||
        compareText(a.approverRoleKey, b.approverRoleKey),
    );
    return resolved.map(({ row, approverRoleKey }) => {
      const base = `${row.actionType}.${row.thresholdIdr ?? "any"}.l${row.levels}.${approverRoleKey}`;
      return {
        key: uniqueKey(base, used),
        actionType: row.actionType,
        thresholdIdr: row.thresholdIdr,
        levels: row.levels,
        approverRoleKey,
        requiresDistinctActor: true as const,
      };
    });
  },

  fromTemplate(
    items: readonly ApprovalPolicyConfigItem[],
    ctx: { roleKeys: ReadonlySet<string> },
  ): ConfigDecodeResult<ApprovalPolicyConfigDraft> {
    const issues: string[] = [];
    const drafts: ApprovalPolicyConfigDraft[] = [];
    const seen = new Map<string, string>();
    const tiers = new Map<string, { label: string; levels: Set<number> }>();
    for (const raw of items) {
      const parsed = approvalPolicyConfigItemSchema.safeParse(raw);
      if (!parsed.success) {
        const key = (raw as { key?: unknown } | null)?.key;
        issues.push(
          `approval_policies item ${String(key)}: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "item"} ${i.message}`)
            .join("; ")}`,
        );
        continue;
      }
      const item = parsed.data;
      if (!ctx.roleKeys.has(item.approverRoleKey))
        issues.push(
          `approval_policies item ${item.key}: approverRoleKey ${item.approverRoleKey} is not a known role`,
        );

      const threshold = item.thresholdIdr ?? "any";
      const rowId = `${item.actionType}|${threshold}|${item.levels}|${item.approverRoleKey}`;
      const firstKey = seen.get(rowId);
      if (firstKey !== undefined)
        issues.push(
          `approval_policies item ${item.key}: duplicate of ${firstKey} (same action, threshold, level and approver)`,
        );
      else seen.set(rowId, item.key);

      const tierId = `${item.actionType}|${threshold}`;
      const tier = tiers.get(tierId) ?? {
        label: `${item.actionType} threshold ${threshold}`,
        levels: new Set<number>(),
      };
      tier.levels.add(item.levels);
      tiers.set(tierId, tier);

      drafts.push({ ...item });
    }
    for (const { label, levels } of tiers.values()) {
      const max = Math.max(...levels);
      for (let level = 1; level <= max; level++)
        if (!levels.has(level))
          issues.push(
            `approval_policies ${label}: level ${level} is missing, levels must be contiguous from 1 to ${max}`,
          );
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, drafts };
  },
};
