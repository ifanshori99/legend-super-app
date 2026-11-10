// Favorite items of one customer (legend-ts50, Customer 360 and the member
// PWA). Counts the quantity of non-voided lines on completed (paid) orders
// attached to the profile; a draft or unpaid order never counts. The caller
// owns the transaction (staff `withTenant` or member `withMemberScope`), so RLS
// scopes the rows; the profile id is a parameter of the caller, never of a
// request body.

import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CustomerFavoriteItem } from "@starter/shared/crm";
import type * as schema from "../db/schema";
import { orderItems, orders } from "../db/schema/qr-order";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const FAVORITE_ITEMS_LIMIT = 10;

export async function memberFavorites(
  tx: Tx,
  profileId: string,
  limit = FAVORITE_ITEMS_LIMIT,
): Promise<CustomerFavoriteItem[]> {
  const quantity = sql<number>`sum(${orderItems.quantity})::int`;
  const lastOrderedAt = sql<Date>`max(${orders.placedAt})`;
  const rows = await tx
    .select({
      menuItemId: orderItems.menuItemId,
      name: sql<string>`(array_agg(${orderItems.name} ORDER BY ${orders.placedAt} DESC))[1]`,
      quantity,
      lastOrderedAt,
    })
    .from(orderItems)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, orderItems.tenantId),
        eq(orders.id, orderItems.orderId),
      ),
    )
    .where(
      and(
        eq(orders.customerProfileId, profileId),
        eq(orders.status, "completed"),
        ne(orderItems.status, "voided"),
      ),
    )
    .groupBy(orderItems.menuItemId)
    .orderBy(desc(quantity), desc(lastOrderedAt))
    .limit(limit);
  return rows
    .filter((row) => row.quantity > 0)
    .map((row) => ({
      menuItemId: row.menuItemId,
      name: row.name,
      quantity: row.quantity,
      lastOrderedAt: new Date(row.lastOrderedAt).toISOString(),
    }));
}
