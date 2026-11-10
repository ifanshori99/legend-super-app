// Idempotency for profit-share commands (submit, decide, record payment;
// bead legend-2ljb). A command body carries `idempotencyKey`; the first call
// claims it inside the command's transaction. A retry with the same key and
// the same request is a replay: the caller returns the current state and does
// NOT transition again. The same key with any other request is a 409.
import { and, eq } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import type { TenantTransaction } from "./accounting-shared";
import { profitShareCommands } from "../db/schema";
import { requestFingerprint } from "./inventory-ops.shared";

export type ProfitShareCommandClaim = {
  tenantId: string;
  idempotencyKey: string;
  /** e.g. "share_version.submit", "distribution.decide", "distribution.pay". */
  operation: string;
  /** The object the command acts on (entity:version, run id, line id). */
  targetId: string;
  actorId: string;
  /** Canonical request body without the key. */
  request: unknown;
};

/** Returns "replay" when this exact command already ran, "new" otherwise. */
export async function claimProfitShareCommand(
  tx: TenantTransaction,
  claim: ProfitShareCommandClaim,
): Promise<"new" | "replay"> {
  const fingerprint = requestFingerprint(claim.operation, claim.actorId, [
    claim.targetId,
    claim.request,
  ]);
  const inserted = await tx
    .insert(profitShareCommands)
    .values({
      tenantId: claim.tenantId,
      idempotencyKey: claim.idempotencyKey,
      operation: claim.operation,
      targetId: claim.targetId,
      fingerprint,
      actorId: claim.actorId,
    })
    .onConflictDoNothing()
    .returning({ key: profitShareCommands.idempotencyKey });
  if (inserted.length > 0) return "new";
  const [existing] = await tx
    .select({ fingerprint: profitShareCommands.fingerprint })
    .from(profitShareCommands)
    .where(
      and(
        eq(profitShareCommands.tenantId, claim.tenantId),
        eq(profitShareCommands.idempotencyKey, claim.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing?.fingerprint === fingerprint) return "replay";
  throw new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was already used for a different request.",
  );
}
