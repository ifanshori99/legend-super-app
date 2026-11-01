import { customType, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  businessDateSchema,
  decimal4,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidSchema,
  uuidToUlid,
} from "@starter/shared/core";
import type { Decimal4, Idr, OutletId, TenantId } from "@starter/shared/core";

/** ULID in application code, UUID bytes in PostgreSQL (D-CORE-1). */
export const ulidInUuid = customType<{ data: string; driverData: string }>({
  dataType: () => "uuid",
  toDriver: ulidToUuid,
  fromDriver: uuidToUlid,
});

/** UUID IDs can be branded per aggregate with .$type<AggregateId>(). */
export const uuidId = customType<{ data: string; driverData: string }>({
  dataType: () => "uuid",
  toDriver: (value) => uuidSchema.parse(value),
  fromDriver: (value) => uuidSchema.parse(value),
});

/** References must point to real tenant and outlet columns. */
export const tenantIdColumn = (target: () => AnyPgColumn, name = "tenant_id") =>
  uuid(name).$type<TenantId>().references(target);
export const outletIdColumn = (target: () => AnyPgColumn, name = "outlet_id") =>
  uuid(name).$type<OutletId>().references(target);
// These schemas are also the boundary validators for tenant/outlet IDs.
export { tenantIdSchema, outletIdSchema };

/** Whole rupiah; validate both directions before JavaScript can lose precision. */
export const idrColumn = customType<{ data: Idr; driverData: string }>({
  dataType: () => "bigint",
  toDriver: (value) => String(idr(value)),
  fromDriver: (value) => {
    const integer = BigInt(value);
    if (
      integer > BigInt(Number.MAX_SAFE_INTEGER) ||
      integer < BigInt(Number.MIN_SAFE_INTEGER)
    )
      throw new RangeError("Rupiah amount exceeds the safe integer range");
    return idr(Number(integer));
  },
});

/** Exact four-place quantity or unit cost, never a float (D-CORE-2). */
export const decimal4Column = customType<{
  data: Decimal4;
  driverData: string;
}>({
  dataType: () => "numeric(14,4)",
  toDriver: decimal4,
  fromDriver: decimal4,
});

/** PostgreSQL DATE is a calendar date, not an instant. */
export const businessDate = customType<{ data: string; driverData: string }>({
  dataType: () => "date",
  toDriver: (value) => businessDateSchema.parse(value),
  fromDriver: (value) => businessDateSchema.parse(value),
});
