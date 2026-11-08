// TEN-09: export/import of the access sections (roles, approval_policies).
// Items carry keys instead of ids; the orchestrator opens the transaction
// (`withTenant`) and the import order guarantees roles run before
// approval_policies. Imports skip rows that already exist and never edit them.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { OutletId, TenantId } from "@starter/shared/core";
import {
  AccessError,
  isRoleTemplateKey,
  normalizeCustomRolePermissions,
  permissionsRequireMfa,
  type PermissionCode,
  roleTemplate,
  scopeTypeSchema,
} from "@starter/shared/access";
import {
  approvalPolicies,
  outlets,
  posApprovalPolicies,
  roles,
} from "../db/schema/index.ts";
import {
  ConfigImportError,
  configKey,
  outletKey,
  type SectionHandler,
} from "./tenant-config-types.ts";
import { loadTenantKeyMaps } from "./tenant-config-keys.ts";

const itemKeySchema = z.string().min(1).max(100);

const roleItemSchema = z.object({
  key: itemKeySchema,
  kind: z.enum(["template", "custom"]),
  templateKey: z.string().min(1).max(50).nullable(),
  name: z.string().min(1).max(100),
  permissions: z.array(z.string()).max(300),
  mfaRequired: z.boolean(),
  allowedScopeTypes: z.array(scopeTypeSchema).min(1),
});

const approvalItemSchema = z.object({
  key: itemKeySchema,
  kind: z.literal("approval"),
  actionType: z.string().min(1).max(50),
  thresholdIdr: z.number().int().min(0).nullable(),
  approverRoleKey: itemKeySchema,
  levels: z.number().int().min(1).max(3),
  requiresDistinctActor: z.boolean(),
});

const posDiscountItemSchema = z.object({
  key: itemKeySchema,
  kind: z.literal("pos_discount"),
  outletKey: z.string().min(1).max(100).nullable(),
  discountThresholdBp: z.number().int().min(1).max(10000),
});

const rolesPayloadSchema = z.object({
  version: z.literal(1),
  items: z.array(roleItemSchema),
});

const approvalPoliciesPayloadSchema = z.object({
  version: z.literal(1),
  items: z.array(
    z.discriminatedUnion("kind", [approvalItemSchema, posDiscountItemSchema]),
  ),
});

function parsePayload<T>(
  section: string,
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ConfigImportError(
      `Section ${section} is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  return parsed.data;
}

function requireKey(map: Map<string, string>, id: string): string {
  const key = map.get(id);
  if (!key) throw new Error(`No config key for row ${id}.`);
  return key;
}

const rolesHandler: SectionHandler = {
  section: "roles",
  async exportSection({ tx, tenantId }) {
    const rows = await tx
      .select()
      .from(roles)
      .where(eq(roles.tenantId, tenantId))
      .orderBy(asc(roles.isTemplate), asc(roles.templateKey), asc(roles.name));
    if (rows.length === 0) return undefined;
    const { role: roleKeys } = await loadTenantKeyMaps(tx, tenantId);
    return {
      version: 1,
      items: rows.map((row) => ({
        key: requireKey(roleKeys, row.id),
        kind: row.isTemplate ? "template" : "custom",
        templateKey: row.templateKey,
        name: row.name,
        permissions: [...row.permissions],
        mfaRequired: row.mfaRequired,
        allowedScopeTypes: [...row.allowedScopeTypes],
      })),
    };
  },

  async importSection({ tx, tenantId, keys, warn }, payload) {
    const { items } = parsePayload("roles", rolesPayloadSchema, payload);
    for (const item of items) {
      let mfaRequired = item.mfaRequired;
      let permissions: string[] = [];
      if (item.kind === "template") {
        if (!isRoleTemplateKey(item.templateKey))
          throw new ConfigImportError(
            `Unknown role template "${item.templateKey ?? ""}" in the bundle.`,
          );
        const template = roleTemplate(item.templateKey);
        if (template.level !== "tenant")
          throw new ConfigImportError(
            `Role template "${item.templateKey}" is not a tenant role template.`,
          );
        // A template role never gets more than the template grants.
        // Base set plus the template's optional toggles (PRD §3.7).
        const allowed = new Set<string>([
          ...template.permissions,
          ...template.optionalPermissions,
        ]);
        for (const code of new Set(item.permissions)) {
          if (!allowed.has(code))
            throw new ConfigImportError(
              `Role "${item.name}" has permission "${code}" that template "${item.templateKey}" does not grant.`,
            );
          permissions.push(code);
        }
        // Never weaker than the template, nor than its permissions need.
        mfaRequired =
          template.mfaRequired ||
          item.mfaRequired ||
          permissionsRequireMfa(permissions as PermissionCode[]);
      } else {
        if (item.templateKey !== null)
          throw new ConfigImportError(
            `Custom role "${item.name}" must not carry a template key.`,
          );
        try {
          const normalized = normalizeCustomRolePermissions(item.permissions, {
            mfaRequested: item.mfaRequired,
          });
          permissions = normalized.permissions;
          mfaRequired = normalized.mfaRequired;
        } catch (error) {
          if (error instanceof AccessError)
            throw new ConfigImportError(
              `Role "${item.name}" has a permission that tenant roles cannot hold (${error.code}).`,
            );
          throw error;
        }
      }

      // Templates match by template key; customs by name, and only against a
      // target CUSTOM role. A name held by the wrong kind of role is skipped
      // with a warning: never aliased, never an abort.
      const [byKey] =
        item.kind === "template"
          ? await tx
              .select({ id: roles.id })
              .from(roles)
              .where(
                and(
                  eq(roles.tenantId, tenantId),
                  eq(roles.templateKey, item.templateKey as never),
                ),
              )
              .limit(1)
          : [];
      if (byKey) {
        keys.roles.set(item.key, byKey.id);
        continue;
      }
      const [byName] = await tx
        .select({ id: roles.id, isTemplate: roles.isTemplate })
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), eq(roles.name, item.name)))
        .limit(1);
      if (byName && (item.kind === "template" || byName.isTemplate)) {
        warn(
          item.kind === "template"
            ? `Skipped template role "${item.name}": the target already has a custom role with that name.`
            : `Skipped custom role "${item.name}": the target has a template role with that name.`,
        );
        keys.roles.delete(item.key);
        continue;
      }
      if (byName) {
        keys.roles.set(item.key, byName.id);
        continue;
      }

      const [created] = await tx
        .insert(roles)
        .values({
          tenantId,
          name: item.name,
          isTemplate: item.kind === "template",
          templateKey:
            item.kind === "template" ? (item.templateKey as never) : null,
          permissions: permissions as never,
          mfaRequired,
          allowedScopeTypes: item.allowedScopeTypes,
        })
        .onConflictDoNothing()
        .returning({ id: roles.id });
      if (!created)
        throw new ConfigImportError(
          `Role "${item.name}" conflicts with an existing role in the target tenant.`,
        );
      keys.roles.set(item.key, created.id);
    }
  },
};

const approvalPoliciesHandler: SectionHandler = {
  section: "approval_policies",
  async exportSection({ tx, tenantId }) {
    const matrix = await tx
      .select({
        policy: approvalPolicies,
      })
      .from(approvalPolicies)
      .where(eq(approvalPolicies.tenantId, tenantId))
      .orderBy(
        asc(approvalPolicies.actionType),
        asc(approvalPolicies.thresholdIdr),
        asc(approvalPolicies.levels),
      );
    const { role: roleKeys } = await loadTenantKeyMaps(tx, tenantId);
    const discounts = await tx
      .select({
        outletCode: outlets.code,
        discountThresholdBp: posApprovalPolicies.discountThresholdBp,
      })
      .from(posApprovalPolicies)
      .leftJoin(
        outlets,
        and(
          eq(outlets.tenantId, posApprovalPolicies.tenantId),
          eq(outlets.id, posApprovalPolicies.outletId),
        ),
      )
      .where(eq(posApprovalPolicies.tenantId, tenantId as TenantId))
      .orderBy(asc(outlets.code));

    const items: Array<Record<string, unknown> & { key: string }> = [];
    for (const { policy } of matrix) {
      const approverRoleKey = requireKey(roleKeys, policy.approverRoleId);
      items.push({
        key: configKey(
          "ap",
          policy.actionType,
          policy.thresholdIdr ?? "any",
          policy.levels,
          approverRoleKey,
        ),
        kind: "approval",
        actionType: policy.actionType,
        thresholdIdr: policy.thresholdIdr,
        approverRoleKey,
        levels: policy.levels,
        requiresDistinctActor: policy.requiresDistinctActor,
      });
    }
    for (const discount of discounts) {
      const key = discount.outletCode ? outletKey(discount.outletCode) : null;
      items.push({
        key: configKey("pos-discount", key ?? "tenant"),
        kind: "pos_discount",
        outletKey: key,
        discountThresholdBp: discount.discountThresholdBp,
      });
    }
    return items.length === 0 ? undefined : { version: 1, items };
  },

  async importSection({ tx, tenantId, keys, warn }, payload) {
    const { items } = parsePayload(
      "approval_policies",
      approvalPoliciesPayloadSchema,
      payload,
    );
    for (const item of items) {
      if (item.kind === "approval") {
        if (!item.requiresDistinctActor)
          throw new ConfigImportError(
            `Approval policy "${item.key}" must require a distinct actor (requiresDistinctActor=true).`,
          );
        const approverRoleId = keys.need("roles", item.approverRoleKey);
        const [existing] = await tx
          .select({ id: approvalPolicies.id })
          .from(approvalPolicies)
          .where(
            and(
              eq(approvalPolicies.tenantId, tenantId),
              eq(approvalPolicies.actionType, item.actionType),
              sql`coalesce(${approvalPolicies.thresholdIdr}, -1) = ${item.thresholdIdr ?? -1}`,
              eq(approvalPolicies.levels, item.levels),
              eq(approvalPolicies.approverRoleId, approverRoleId),
            ),
          )
          .limit(1);
        if (existing) continue;
        await tx.insert(approvalPolicies).values({
          tenantId,
          actionType: item.actionType,
          thresholdIdr: item.thresholdIdr,
          approverRoleId,
          levels: item.levels,
          requiresDistinctActor: item.requiresDistinctActor,
        });
        continue;
      }

      let outletId: string | null = null;
      if (item.outletKey !== null) {
        outletId = keys.outlets.get(item.outletKey) ?? null;
        if (!outletId) {
          warn(
            `Skipped POS discount policy "${item.key}": no target outlet "${item.outletKey}".`,
          );
          continue;
        }
      }
      const [existing] = await tx
        .select({ id: posApprovalPolicies.id })
        .from(posApprovalPolicies)
        .where(
          and(
            eq(posApprovalPolicies.tenantId, tenantId as TenantId),
            outletId === null
              ? isNull(posApprovalPolicies.outletId)
              : eq(posApprovalPolicies.outletId, outletId as OutletId),
          ),
        )
        .limit(1);
      if (existing) continue;
      await tx.insert(posApprovalPolicies).values({
        tenantId: tenantId as TenantId,
        outletId: outletId as OutletId | null,
        discountThresholdBp: item.discountThresholdBp,
      });
    }
  },
};

export const accessSectionHandlers: SectionHandler[] = [
  rolesHandler,
  approvalPoliciesHandler,
];
