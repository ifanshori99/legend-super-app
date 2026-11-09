// Holiday calendar (PRD v1.7 §3 Kelompok D 29 "Cuti, Izin & Lembur", §6 H
// `holidays`; bead legend-hggk). Routes: routes/hris-leave.routes.ts.
//
// - Rows with `outlet_id` NULL are tenant-wide (national / collective); a row
//   with an outlet is a company holiday of that outlet. Tenant-wide rows need
//   tenant-wide HR manage reach, outlet rows need HR manage at that outlet.
// - Anyone with HRIS read reach or an own employee row can read the calendar
//   (it is not personal data); outlet rows are limited to the reader's outlets.
// - Writes are idempotent per `Idempotency-Key` (hris_idempotency) and a
//   duplicate (outlet, date) is a 409 (unique NULLS NOT DISTINCT).
// - `idempotentHrisWrite` is exported for the overtime formula writes.
// - Collective days: a create or a move/retype into a year whose carry-over
//   ran is a 422 `LEAVE_YEAR_CARRIED_OVER`; deleting, moving or retyping a
//   collective day reverses its deductions in the same transaction
//   (hris-leave-collective.service.ts).

import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  CoreError,
  businessDateSchema,
  encodeCursor,
  idempotencyKeySchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { z } from "@starter/shared/core";
import {
  holidaySchema,
  createHoliday as createHolidayEndpoint,
  listHolidays as listHolidaysEndpoint,
  updateHoliday as updateHolidayEndpoint,
  type Holiday,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { hrisIdempotency } from "../db/schema/hris.ts";
import { holidays } from "../db/schema/hris-leave.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { hrisRequestFingerprint } from "../lib/hris-pii.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  HRIS_READ_CODES,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import {
  assertCollectiveYearOpen,
  reverseCollectiveLeaveDeductions,
} from "./hris-leave-collective.service.ts";

type HolidayRow = typeof holidays.$inferSelect;
type ListHolidaysQuery = z.output<typeof listHolidaysEndpoint.query>;
type CreateHolidayBody = z.output<typeof createHolidayEndpoint.body>;
type UpdateHolidayBody = z.output<typeof updateHolidayEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Audit fields these services add to the HRIS list (values are not PII). */
export const HRIS_LEAVE_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "date",
  "version",
  "minutes",
  "dayType",
  "outletId",
  "formulaId",
  "action",
  "approvalOutcome",
  "reversed",
] as const;

export function toHoliday(row: HolidayRow): Holiday {
  return holidaySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    date: row.date,
    name: row.name,
    type: row.type,
    outletId: row.outletId,
  });
}

/** Idempotent HRIS write bound to an HMAC fingerprint of the request. */
export async function idempotentHrisWrite<T>(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const parsedKey = idempotencyKeySchema.parse(key);
  const fingerprint = hrisRequestFingerprint(context.tenant.tenantId, {
    operation,
    request,
  });
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:idem:${context.tenant.tenantId}:${parsedKey}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(hrisIdempotency)
    .where(
      and(
        eq(hrisIdempotency.tenantId, context.tenant.tenantId),
        eq(hrisIdempotency.key, parsedKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== operation ||
      existing.fingerprint !== fingerprint
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(hrisIdempotency).values({
    tenantId: context.tenant.tenantId,
    key: parsedKey,
    operation,
    fingerprint,
    response: response as object,
  });
  return response;
}

const badCursor = () =>
  new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `[date, id]` cursor whose parts are typed values: a bad cursor is a 422,
 * never a Postgres cast error (500) in the keyset comparison.
 */
export function cursorDateId(cursor: string): [string, string] {
  const [date, id] = cursorPair(cursor);
  if (!businessDateSchema.safeParse(date).success || !UUID_PATTERN.test(id))
    throw badCursor();
  return [date, id];
}

/** A `[version, id]` cursor: positive integer version and a uuid. */
export function cursorVersionId(cursor: string): [number, string] {
  const [version, id] = cursorPair(cursor);
  const parsed = Number(version);
  if (
    !/^\d{1,9}$/.test(version) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    !UUID_PATTERN.test(id)
  )
    throw badCursor();
  return [parsed, id];
}

function foreignKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23503" ||
    foreignKeyViolation(candidate.cause, depth + 1)
  );
}

/** Tenant-wide rows (outlet null) need tenant reach; outlet rows need the outlet. */
function canManage(access: HrisAccess, outletId: string | null): boolean {
  if (outletId === null)
    return access.reach([HRIS_MANAGE_CODE])?.kind === "tenant";
  return access.permissionsAt(outletId).includes(HRIS_MANAGE_CODE);
}

/** Audit row for a tenant-wide or outlet row; tenant-wide is filed tenant-wide. */
export function tenantOrOutletAudit(
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  entry: {
    readonly outletId: string | null;
    readonly action: string;
    readonly objectType: string;
    readonly objectId: string;
    readonly after: Record<string, unknown> | null;
  },
) {
  const base = hrisAuditEntry(context, actor, now, {
    // Any value works for a tenant-wide row: it is replaced below.
    outletId: entry.outletId ?? "00000000-0000-0000-0000-000000000000",
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    after: entry.after,
  });
  if (entry.outletId !== null) return base;
  if (context.outletScope.kind === "tenant") return { ...base, outletId: null };
  return base; // narrowed scope: the entry is already filed at its first outlet
}

const duplicateHoliday = () =>
  new HttpError(
    409,
    "CONFLICT",
    "Hari libur pada tanggal ini sudah ada untuk outlet tersebut.",
  );

// ------------------------------------------------------------------- reads

/** GET /api/hris/holidays — the calendar the caller may see, by date. */
export async function listHolidays(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListHolidaysQuery,
  now: Date = new Date(),
): Promise<Page<Holiday>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach(HRIS_READ_CODES);
    if (reach === null && access.own === null) throw forbidden();
    const filters: SQL[] = [eq(holidays.tenantId, context.tenant.tenantId)];
    if (reach?.kind !== "tenant") {
      const outletIds = new Set<string>(
        reach?.kind === "outlets" ? reach.outletIds : [],
      );
      if (access.own) outletIds.add(access.own.homeOutletId.toLowerCase());
      const visible = or(
        isNull(holidays.outletId),
        outletIds.size > 0
          ? inArray(holidays.outletId, [...outletIds])
          : undefined,
      );
      if (visible) filters.push(visible);
    }
    if (query.year !== undefined) {
      filters.push(gte(holidays.date, `${query.year}-01-01`));
      filters.push(lte(holidays.date, `${query.year}-12-31`));
    }
    if (query.cursor) {
      const [date, id] = cursorDateId(query.cursor);
      filters.push(
        or(
          gt(holidays.date, date),
          and(eq(holidays.date, date), gt(holidays.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(holidays)
      .where(and(...filters))
      .orderBy(asc(holidays.date), asc(holidays.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toHoliday),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.date, last.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------------ writes

/** POST /api/hris/holidays — HR manage; duplicate (outlet, date) → 409. */
export async function createHoliday(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateHolidayBody,
  now: Date = new Date(),
): Promise<Holiday> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (!canManage(access, input.outletId)) throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "holiday.create",
      { actor: access.actorUserId, ...input, idempotencyKey: undefined },
      async () => {
        if (input.type === "collective")
          await assertCollectiveYearOpen(tx, context, input.date);
        let row: HolidayRow | undefined;
        try {
          // A savepoint keeps the transaction usable after a constraint error.
          row = await tx.transaction(async (inner) => {
            const [created] = await inner
              .insert(holidays)
              .values({
                tenantId: context.tenant.tenantId,
                outletId: input.outletId,
                date: input.date,
                name: input.name,
                type: input.type,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            return created;
          });
        } catch (error) {
          if (uniqueViolation(error)) throw duplicateHoliday();
          if (foreignKeyViolation(error))
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "Outlet tidak ditemukan.",
            );
          throw error;
        }
        if (!row) throw new Error("Holiday insert returned no row");
        await recordAudit(
          tx,
          context,
          tenantOrOutletAudit(context, access.actorUserId, now, {
            outletId: row.outletId,
            action: "hris.holiday.created",
            objectType: "holiday",
            objectId: row.id,
            after: { date: row.date, type: row.type },
          }),
          HRIS_LEAVE_AUDIT_SAFE_FIELDS,
        );
        return toHoliday(row);
      },
    );
  });
}

/** Reverses the deductions of a collective row that left its date; audited. */
async function reverseDeductions(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  previous: HolidayRow,
): Promise<void> {
  const reversed = await reverseCollectiveLeaveDeductions(
    tx,
    context,
    actor,
    previous.date,
    now,
  );
  if (reversed === 0) return;
  await recordAudit(
    tx,
    context,
    tenantOrOutletAudit(context, actor, now, {
      outletId: previous.outletId,
      action: "hris.leave_collective.reversed",
      objectType: "holiday",
      objectId: previous.id,
      after: { date: previous.date, reversed },
    }),
    HRIS_LEAVE_AUDIT_SAFE_FIELDS,
  );
}

async function lockHoliday(
  tx: Tx,
  context: ScopedTenantContext,
  holidayId: string,
): Promise<HolidayRow> {
  const [row] = await tx
    .select()
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, context.tenant.tenantId),
        eq(holidays.id, holidayId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw notFound("Hari libur");
  return row;
}

/** PATCH /api/hris/holidays/:holidayId — date, name or type. */
export async function updateHoliday(
  context: ScopedTenantContext,
  actorUserId: string,
  holidayId: string,
  input: UpdateHolidayBody,
  now: Date = new Date(),
): Promise<Holiday> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "holiday.update",
      {
        actor: access.actorUserId,
        holidayId: holidayId.toLowerCase(),
        ...input,
        idempotencyKey: undefined,
      },
      async () => {
        const current = await lockHoliday(tx, context, holidayId);
        if (!canManage(access, current.outletId)) throw forbidden();
        const changed: string[] = [];
        const patch: Partial<HolidayRow> = {};
        if (input.date !== undefined && input.date !== current.date) {
          patch.date = input.date;
          changed.push("date");
        }
        if (input.name !== undefined && input.name !== current.name) {
          patch.name = input.name;
          changed.push("name");
        }
        if (input.type !== undefined && input.type !== current.type) {
          patch.type = input.type;
          changed.push("type");
        }
        if (changed.length === 0) return toHoliday(current);
        const nextType = patch.type ?? current.type;
        const moved = patch.date !== undefined || patch.type !== undefined;
        if (moved && nextType === "collective")
          await assertCollectiveYearOpen(
            tx,
            context,
            patch.date ?? current.date,
          );
        let row: HolidayRow | undefined;
        try {
          row = await tx.transaction(async (inner) => {
            const [updated] = await inner
              .update(holidays)
              .set({ ...patch, updatedAt: now })
              .where(eq(holidays.id, current.id))
              .returning();
            return updated;
          });
        } catch (error) {
          if (uniqueViolation(error)) throw duplicateHoliday();
          throw error;
        }
        if (!row) throw new Error("Holiday update returned no row");
        if (moved && current.type === "collective")
          await reverseDeductions(
            tx,
            context,
            access.actorUserId,
            now,
            current,
          );
        await recordAudit(
          tx,
          context,
          tenantOrOutletAudit(context, access.actorUserId, now, {
            outletId: row.outletId,
            action: "hris.holiday.updated",
            objectType: "holiday",
            objectId: row.id,
            after: { changedFields: changed },
          }),
          HRIS_LEAVE_AUDIT_SAFE_FIELDS,
        );
        return toHoliday(row);
      },
    );
  });
}

/** DELETE /api/hris/holidays/:holidayId — returns the removed id. */
export async function deleteHoliday(
  context: ScopedTenantContext,
  actorUserId: string,
  holidayId: string,
  now: Date = new Date(),
): Promise<{ id: string }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const current = await lockHoliday(tx, context, holidayId);
    if (!canManage(access, current.outletId)) throw forbidden();
    await tx.delete(holidays).where(eq(holidays.id, current.id));
    if (current.type === "collective")
      await reverseDeductions(tx, context, access.actorUserId, now, current);
    await recordAudit(
      tx,
      context,
      tenantOrOutletAudit(context, access.actorUserId, now, {
        outletId: current.outletId,
        action: "hris.holiday.deleted",
        objectType: "holiday",
        objectId: current.id,
        after: { date: current.date, type: current.type },
      }),
      HRIS_LEAVE_AUDIT_SAFE_FIELDS,
    );
    return { id: current.id };
  });
}
