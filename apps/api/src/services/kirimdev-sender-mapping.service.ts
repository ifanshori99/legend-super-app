// Platform-managed Kirimdev sender mapping (legend-nqxtb). One platform
// KIRIM_API_KEY can send from every number in the Kirimdev org, so which number
// a tenant (or one outlet) sends from is decided here, by a platform admin,
// never by tenant config. The table is tenant-RLS'd; like the other platform
// services that touch tenant tables, this acts on the target tenant through
// `withTenant(platformTenantScope(...))`, so the audit row lands in the same
// transaction. Callers (routes) already ran the platform guards; the registry
// standing is checked again here, before tenant IO.
//
// Errors never carry a phone number: a number taken by another tenant is
// reported as SENDER_ALREADY_MAPPED without naming it or its owner.

import type { KirimdevSenderMappingDto } from "@starter/shared/types";
import type {
  ListKirimdevSenderMappingsQuery,
  UpsertKirimdevSenderMappingInput,
} from "@starter/shared/validators/kirimdev-sender";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { kirimdevSenderMappings, outlets, tenants } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./audit-writer";
import { platformTenantScope } from "./platform-org.service";
import { isPlatformAdmin } from "./platform-support.service";

type MappingRow = typeof kirimdevSenderMappings.$inferSelect;

function toDto(row: MappingRow): KirimdevSenderMappingDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    phoneNumberId: row.phoneNumberId,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertPlatformAdmin(actorUserId: string): Promise<void> {
  if (!(await isPlatformAdmin(actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
}

async function assertTenantExists(tenantId: string): Promise<void> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
}

function postgresError(error: unknown): { code?: string; constraint?: string } {
  const candidates = [
    error,
    typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null) {
      const { code, constraint } = candidate as {
        code?: unknown;
        constraint?: unknown;
      };
      if (typeof code === "string")
        return {
          code,
          ...(typeof constraint === "string" ? { constraint } : {}),
        };
    }
  }
  return {};
}

export async function listKirimdevSenderMappingsAny(
  query: ListKirimdevSenderMappingsQuery,
  actorUserId: string,
): Promise<{ data: KirimdevSenderMappingDto[] }> {
  await assertPlatformAdmin(actorUserId);
  await assertTenantExists(query.tenantId);
  const rows = await withTenant(db, platformTenantScope(query.tenantId), (tx) =>
    tx
      .select()
      .from(kirimdevSenderMappings)
      .where(eq(kirimdevSenderMappings.tenantId, query.tenantId))
      .orderBy(
        sql`${kirimdevSenderMappings.outletId} ASC NULLS FIRST`,
        asc(kirimdevSenderMappings.id),
      ),
  );
  return { data: rows.map(toDto) };
}

/**
 * Sets the sender for (tenant, outlet|null). A number already mapped anywhere
 * else (another tenant or another slot) is a 409 SENDER_ALREADY_MAPPED; the
 * database unique index is the arbiter, because RLS hides other tenants' rows
 * from this transaction.
 */
export async function upsertKirimdevSenderMappingAny(
  input: UpsertKirimdevSenderMappingInput,
  actorUserId: string,
): Promise<KirimdevSenderMappingDto> {
  await assertPlatformAdmin(actorUserId);
  await assertTenantExists(input.tenantId);
  const context = platformTenantScope(input.tenantId);
  try {
    const row = await withTenant(db, context, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.kirimdev_sender_write', 'on', true)`,
      );
      if (input.outletId !== null) {
        const [outlet] = await tx
          .select({ id: outlets.id })
          .from(outlets)
          .where(
            and(
              eq(outlets.id, input.outletId),
              eq(outlets.tenantId, input.tenantId),
            ),
          )
          .limit(1);
        if (!outlet)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Outlet does not belong to this tenant.",
          );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kirimdev_sender_mappings:${input.tenantId}`}, 0))`,
      );
      const slot = and(
        eq(kirimdevSenderMappings.tenantId, input.tenantId),
        input.outletId === null
          ? isNull(kirimdevSenderMappings.outletId)
          : eq(kirimdevSenderMappings.outletId, input.outletId),
      );
      const [current] = await tx
        .select()
        .from(kirimdevSenderMappings)
        .where(slot)
        .limit(1);
      let saved: MappingRow | undefined;
      if (current) {
        [saved] = await tx
          .update(kirimdevSenderMappings)
          .set({
            phoneNumberId: input.phoneNumberId,
            updatedByUserId: actorUserId,
            updatedAt: new Date(),
          })
          .where(eq(kirimdevSenderMappings.id, current.id))
          .returning();
      } else {
        [saved] = await tx
          .insert(kirimdevSenderMappings)
          .values({
            tenantId: input.tenantId,
            outletId: input.outletId,
            phoneNumberId: input.phoneNumberId,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning();
      }
      if (!saved)
        throw new Error("Kirimdev sender mapping write returned no row");
      await recordAudit(
        {
          tenantId: input.tenantId,
          outletId: input.outletId,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "platform.kirimdev_sender.upserted",
          objectType: "kirimdev_sender_mapping",
          objectId: saved.id,
          reason: null,
          before: current ? { phoneNumberId: current.phoneNumberId } : null,
          after: { phoneNumberId: saved.phoneNumberId },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      return saved;
    });
    return toDto(row);
  } catch (error) {
    const pg = postgresError(error);
    if (
      pg.code === "23505" &&
      pg.constraint === "kirimdev_sender_mappings_phone_number_key"
    )
      throw new HttpError(
        409,
        "SENDER_ALREADY_MAPPED",
        "This sender is already mapped to a tenant or outlet.",
      );
    if (pg.code === "23505")
      throw new HttpError(
        409,
        "CONFLICT",
        "The sender mapping changed at the same time. Try again.",
      );
    throw error;
  }
}

/**
 * The id alone does not name a tenant, and RLS hides other tenants' rows, so
 * the caller names the tenant. A mapping of another tenant is a plain 404.
 */
export async function deleteKirimdevSenderMappingAny(
  id: string,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  await assertPlatformAdmin(actorUserId);
  await assertTenantExists(tenantId);
  const context = platformTenantScope(tenantId);
  const removed = await withTenant(db, context, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.kirimdev_sender_write', 'on', true)`,
    );
    const [row] = await tx
      .delete(kirimdevSenderMappings)
      .where(
        and(
          eq(kirimdevSenderMappings.id, id),
          eq(kirimdevSenderMappings.tenantId, tenantId),
        ),
      )
      .returning();
    if (!row) return false;
    await recordAudit(
      {
        tenantId,
        outletId: row.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "platform.kirimdev_sender.deleted",
        objectType: "kirimdev_sender_mapping",
        objectId: row.id,
        reason: null,
        before: { phoneNumberId: row.phoneNumberId },
        after: null,
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return true;
  });
  if (!removed)
    throw new HttpError(404, "NOT_FOUND", "Sender mapping not found.");
}
