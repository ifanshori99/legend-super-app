// `approval.resolved` consumer for profit share (Codex 377/379, bead
// legend-33im6). Wired in worker-main.ts next to the journal consumer.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains profit share opened
// (sourceModule `profit_share`; objectType distribution_run or
// shareholder_recipient_version) and delegates to the settle functions, which
// re-read the chain outcome and the final approver from the database under the
// row lock. The event payload is a trigger, never the authority: a forged or
// stale "approved" event cannot approve a chain the database still has pending.
//
// - Other event names, source modules and object types: ignored (not ours).
// - A chain no profit-share row owns: ignored (opening transaction rolled back).
// - Replay: settling a row that is no longer pending returns it unchanged.

import { approvalResolvedEvent } from "@starter/shared/identity";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { shareholderRecipientVersions } from "../db/schema/accounting-profit-share.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import {
  DISTRIBUTION_RUN_OBJECT_TYPE,
  PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
  SHAREHOLDER_RECIPIENT_OBJECT_TYPE,
} from "./profit-share-approval.ts";
import { settleDistributionRunForApproval } from "./profit-share-distribution.service.ts";
import { settleShareholderRecipientVersionForApproval } from "./profit-share-registry.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function payloadField(event: DomainEvent, key: string): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Settles the distribution run or recipient change that owns the resolved
 * chain. Idempotent and replay safe; ignores events that are not ours.
 */
export async function handleProfitShareApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (
    payloadField(event, "sourceModule") !== PROFIT_SHARE_APPROVAL_SOURCE_MODULE
  )
    return;
  const objectType = payloadField(event, "objectType");
  if (
    objectType !== DISTRIBUTION_RUN_OBJECT_TYPE &&
    objectType !== SHAREHOLDER_RECIPIENT_OBJECT_TYPE
  )
    return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success) return;
  const { tenantId } = context.tenant;
  if (parsed.data.tenantId.toLowerCase() !== tenantId.toLowerCase()) return;
  const chainId = parsed.data.payload.chainId;

  await withTenant(db, context, async (tx) => {
    if (objectType === DISTRIBUTION_RUN_OBJECT_TYPE) {
      // A run carries no chain column: the level-1 row (id = chain id) names it.
      const [head] = await tx
        .select({ objectId: approvalRequests.objectId })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, tenantId),
            eq(approvalRequests.id, chainId),
            eq(
              approvalRequests.sourceModule,
              PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
            ),
            eq(approvalRequests.objectType, DISTRIBUTION_RUN_OBJECT_TYPE),
          ),
        )
        .limit(1);
      if (head)
        await settleDistributionRunForApproval(tx, context, head.objectId, now);
      return;
    }
    const [version] = await tx
      .select({ id: shareholderRecipientVersions.id })
      .from(shareholderRecipientVersions)
      .where(
        and(
          eq(shareholderRecipientVersions.tenantId, tenantId),
          eq(shareholderRecipientVersions.approvalChainId, chainId),
        ),
      )
      .limit(1);
    if (version)
      await settleShareholderRecipientVersionForApproval(
        tx,
        context,
        version.id,
        now,
      );
  });
}
