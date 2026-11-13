// Tenant text overrides (PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6 A
// `text_overrides`). A tenant renames the terms it needs (table, station,
// "Zona WFC") without a deploy. Keys are validated against the text catalog at
// the contract (`catalogKeySchema`), so a typo can never look like a working
// override. Each (tenant, locale, key) has one row whose `version` increments
// on every change; every change is audited with before/after.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  textOverrideRecordSchema,
  type TextOverrideRecord,
} from "@starter/shared/platform";
import {
  TERM_DEFINITIONS,
  toPublicTextOverrides,
  type PublicTextOverrides,
  type TextLocale,
  type TextOverrideInput,
} from "@starter/shared/text";
import { db } from "../db/index.ts";
import { textOverrides } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
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

/**
 * Overrides the web server may read with no session (legend-it6p4): the
 * `terms.*` dictionary of the tenant the request host resolved to, grouped by
 * locale. Filtered in SQL and again by the shared allowlist; carries no ids,
 * versions or authors.
 */
export async function getPublicTextOverrides(
  tenant: TenantContext,
): Promise<PublicTextOverrides> {
  const scoped = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, scoped, async (tx) => {
    const rows = await tx
      .select({
        locale: textOverrides.locale,
        key: textOverrides.key,
        value: textOverrides.value,
      })
      .from(textOverrides)
      .where(
        and(
          eq(textOverrides.tenantId, tenant.tenantId),
          inArray(
            textOverrides.key,
            TERM_DEFINITIONS.map((term) => term.key),
          ),
        ),
      )
      .orderBy(asc(textOverrides.locale), asc(textOverrides.key));
    return toPublicTextOverrides(rows);
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

/**
 * Clears a term: deletes the row (never stores an empty value). The id is
 * matched together with the tenant in SQL, so another tenant's override is
 * answered 404 exactly like a missing one.
 */
export async function deleteTextOverride(
  context: ScopedTenantContext,
  overrideId: string,
  actorUserId: string,
): Promise<void> {
  assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .delete(textOverrides)
      .where(
        and(
          eq(textOverrides.tenantId, tenantId),
          eq(textOverrides.id, overrideId),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Text override not found.");

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
        action: "text_override.deleted",
        objectType: "text_override",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: { key: row.key, value: row.value, version: row.version },
          after: null,
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      },
      ["key", "value", "version"],
    );
  });
}
