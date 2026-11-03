// Tenant text overrides (PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6 A
// `text_overrides`). A tenant renames the terms it needs (table, station,
// "Zona WFC") without a deploy. Keys are validated against the text catalog at
// the contract (`catalogKeySchema`), so a typo can never look like a working
// override. Each (tenant, locale, key) has one row whose `version` increments
// on every change; every change is audited with before/after.

import { and, asc, eq, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  textOverrideRecordSchema,
  type TextOverrideRecord,
} from "@starter/shared/platform";
import type { TextLocale, TextOverrideInput } from "@starter/shared/text";
import { db } from "../db/index.ts";
import { textOverrides } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";

type Row = typeof textOverrides.$inferSelect;

function toRecord(row: Row): TextOverrideRecord {
  return textOverrideRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    locale: row.locale,
    key: row.key,
    value: row.value,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function assertTenantWide(context: ScopedTenantContext): void {
  if (context.outletScope.kind !== "tenant")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
}

export async function listTextOverrides(
  context: ScopedTenantContext,
  query: { locale?: TextLocale },
): Promise<{ data: TextOverrideRecord[] }> {
  assertTenantWide(context);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(textOverrides)
      .where(
        and(
          eq(textOverrides.tenantId, context.tenant.tenantId),
          ...(query.locale ? [eq(textOverrides.locale, query.locale)] : []),
        ),
      )
      .orderBy(asc(textOverrides.locale), asc(textOverrides.key));
    return { data: rows.map(toRecord) };
  });
}

/** Creates the override or replaces its value, bumping the version. */
export async function putTextOverride(
  context: ScopedTenantContext,
  input: TextOverrideInput,
  actorUserId: string,
): Promise<TextOverrideRecord> {
  assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [before] = await tx
      .select()
      .from(textOverrides)
      .where(
        and(
          eq(textOverrides.tenantId, tenantId),
          eq(textOverrides.locale, input.locale),
          eq(textOverrides.key, input.key),
        ),
      )
      .limit(1)
      .for("update");
    // Unchanged value: no new version, no audit noise (idempotent PUT).
    if (before && before.value === input.value) return toRecord(before);

    const [row] = await tx
      .insert(textOverrides)
      .values({
        tenantId,
        locale: input.locale,
        key: input.key,
        value: input.value,
        updatedBy: actorUserId,
      })
      .onConflictDoUpdate({
        target: [
          textOverrides.tenantId,
          textOverrides.locale,
          textOverrides.key,
        ],
        set: {
          value: input.value,
          version: sql`${textOverrides.version} + 1`,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("Text override was not saved");

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: before ? "text_override.updated" : "text_override.created",
        objectType: "text_override",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: before
            ? { key: before.key, value: before.value, version: before.version }
            : null,
          after: { key: row.key, value: row.value, version: row.version },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      },
      ["key", "value", "version"],
    );
    return toRecord(row);
  });
}
