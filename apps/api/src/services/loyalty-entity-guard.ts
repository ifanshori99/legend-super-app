// A nonblocking entity check for work already holding order/member locks.
import { eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { loyaltyPrograms, outlets, tenants } from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];
export type LoyaltyEntityCheck = "ok" | "busy" | "ambiguous" | "mismatch";

export async function checkLoyaltyOutletEntity(
  tx: Tx,
  tenantId: TenantId,
  outletIds: readonly string[],
): Promise<LoyaltyEntityCheck> {
  try {
    return await tx.transaction(async (savepoint) => {
      const lock = await savepoint.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`loyalty-entity:${tenantId}`}, 0)) AS locked`,
      );
      if (lock.rows[0]?.locked !== true) return "busy";
      const [program] = await savepoint
        .select({ legalEntityId: loyaltyPrograms.legalEntityId })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.tenantId, tenantId));
      if (!program?.legalEntityId)
        await savepoint
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for("update", { noWait: true });
      const rows = await savepoint
        .select({ id: outlets.id, legalEntityId: outlets.legalEntityId })
        .from(outlets)
        .where(eq(outlets.tenantId, tenantId))
        .for("share", { noWait: true });
      const entities = new Set(rows.map((row) => row.legalEntityId));
      const selected =
        program?.legalEntityId ??
        (entities.size === 1 ? rows[0]?.legalEntityId : null);
      if (!selected) return "ambiguous";
      return outletIds.every((id) =>
        rows.some((row) => row.id === id && row.legalEntityId === selected),
      )
        ? "ok"
        : "mismatch";
    });
  } catch (error) {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 5 && current && typeof current === "object";
      depth += 1
    ) {
      const item = current as { code?: unknown; cause?: unknown };
      if (item.code === "55P03") return "busy";
      current = item.cause;
    }
    throw error;
  }
}
