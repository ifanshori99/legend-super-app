// Profit-share registry (PRD v1.7 §3.37 Entitas Bagi Hasil, Daftar Pemegang
// Saham, Daftar Pemegang Saham Berversi; SH-03; bead legend-2ljb).
//
// Profit entities and shareholders are plain CRUD (NPWP and payout account are
// sealed with `sealSecret`, only the last four digits stay clear and the API
// returns the masked form). A share allocation version is the approval unit:
//
//   draft ─submit→ pending_approval ─approve→ approved
//                                  └reject→ rejected
//
// The state machine, the 100% check and the date-order rule come from the
// shared contract (`transitionShareAllocationVersion`, `assertUniqueShareholders`,
// `assertEffectiveFromAdvances`); the migration adds the same guards in the
// database. A version number is max + 1 per entity, taken under a row lock on
// the entity so two creates never race for one number.
//
// Idempotency: create stores the key on the row (UNIQUE tenant, key). Same key
// and same body replays the stored row, same key and another body is 409. A
// submit/decide command claims its key in `profit_share_commands` before the
// transition: a replay returns the current state with no second transition.
//
// A shareholder's linked login (the statement recipient) is not patched in
// place (Codex 379, bead legend-33im6): changing it, including link and unlink,
// writes a `shareholder_recipient_versions` row and opens an approval chain
// (matrix action `shareholder_version`). `shareholders.user_id` moves only when
// `settleShareholderRecipientVersionForApproval` applies the approved outcome.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import {
  assertEffectiveFromAdvances,
  assertUniqueShareholders,
  createProfitEntityInputSchema,
  createShareAllocationVersionInputSchema,
  createShareholderInputSchema,
  profitEntitySchema,
  shareAllocationVersionSchema,
  shareholderSchema,
  shareVersionDecisionInputSchema,
  transitionShareAllocationVersion,
  updateProfitEntityInputSchema,
  updateShareAllocationVersionInputSchema,
  updateShareholderInputSchema,
  type ProfitEntity,
  type ShareAllocation,
  type ShareAllocationVersion,
  type ShareAllocationVersionStatus,
  type Shareholder,
} from "@starter/shared/accounting";
import { AccountingError } from "@starter/shared/accounting";
import { AccessError, type SelfApprovalBasis } from "@starter/shared/access";
import {
  CoreError,
  assertTrustedScopedContext,
  type BusinessDate,
  type IsoDateTime,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
  userIdSchema,
} from "@starter/shared/core";
import type { z } from "zod";
import { db } from "../db";
import {
  profitEntities,
  shareAllocations,
  shareAllocationVersions,
  shareholderRecipientVersions,
  shareholders,
} from "../db/schema";
import { approvalRequests } from "../db/schema/platform-approval";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { sealSecret } from "../lib/secrets";
import {
  auditAccountingChange,
  requireLegalEntity,
  requireOutlet,
  uniqueViolation,
  type TenantTransaction,
} from "./accounting-shared";
import { claimProfitShareCommand } from "./profit-share-idempotency";
import {
  lockAndCheckSoleOwnerSelfApproval,
  soleOwnerSelfApprovalPreview,
} from "./sole-owner-self-approval";
import {
  PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
  SHARE_ALLOCATION_VERSION_OBJECT_TYPE,
  SHAREHOLDER_RECIPIENT_OBJECT_TYPE,
} from "./profit-share-approval";
import {
  cancelApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";

type EntityRow = typeof profitEntities.$inferSelect;
type ShareholderRow = typeof shareholders.$inferSelect;
type VersionRow = typeof shareAllocationVersions.$inferSelect;
type AllocationRow = typeof shareAllocations.$inferSelect;
type RecipientVersionRow = typeof shareholderRecipientVersions.$inferSelect;

export type CreateProfitEntityInput = z.infer<
  typeof createProfitEntityInputSchema
>;
export type UpdateProfitEntityInput = z.infer<
  typeof updateProfitEntityInputSchema
>;
export type CreateShareholderInput = z.infer<
  typeof createShareholderInputSchema
>;
export type UpdateShareholderInput = z.infer<
  typeof updateShareholderInputSchema
>;
export type CreateShareAllocationVersionInput = z.infer<
  typeof createShareAllocationVersionInputSchema
>;
export type UpdateShareAllocationVersionInput = z.infer<
  typeof updateShareAllocationVersionInputSchema
>;
export type ShareVersionDecisionInput = z.infer<
  typeof shareVersionDecisionInputSchema
>;

const iso = (value: Date | string) => new Date(value).toISOString();
const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} not found.`);

// ---------------------------------------------------------------- mapping

function toEntity(row: EntityRow): ProfitEntity {
  return profitEntitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    type: row.type,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    policy: {
      basis: row.basis,
      reserveBp: row.reserveBp,
      frequency: row.frequency,
      taxWithholdingBp: row.taxWithholdingBp,
    },
    isActive: row.isActive,
  });
}

function toShareholder(row: ShareholderRow): Shareholder {
  return shareholderSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    name: row.name,
    type: row.type,
    status: row.status,
    // Only the masked form leaves the service; the sealed value never does.
    npwpMasked: row.npwpLast4 ? `****${row.npwpLast4}` : null,
    payoutAccount:
      row.payoutBank && row.payoutAccountLast4 && row.payoutAccountHolder
        ? {
            bank: row.payoutBank,
            accountNumberMasked: `****${row.payoutAccountLast4}`,
            accountHolder: row.payoutAccountHolder,
          }
        : null,
    createdAt: iso(row.createdAt),
  });
}

function toVersion(
  row: VersionRow,
  allocations: readonly AllocationRow[],
): ShareAllocationVersion {
  return shareAllocationVersionSchema.parse({
    tenantId: row.tenantId,
    profitEntityId: row.profitEntityId,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    allocations: [...allocations]
      .sort((a, b) => a.position - b.position)
      .map((allocation) => ({
        id: allocation.id,
        shareholderId: allocation.shareholderId,
        shareBp: allocation.shareBp,
      })),
    requestedBy: row.requestedBy,
    requestedAt: iso(row.requestedAt),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
    decisionNote: row.decisionNote,
  });
}

/** The slice of a version row the contract state machine reads. */
function transitionState(
  row: VersionRow,
  allocations: readonly AllocationRow[],
): Pick<ShareAllocationVersion, "status" | "requestedBy" | "allocations"> {
  return {
    status: row.status,
    requestedBy: row.requestedBy as UserId,
    allocations: allocations.map((allocation) => ({
      id: allocation.id as ShareAllocation["id"],
      shareholderId:
        allocation.shareholderId as ShareAllocation["shareholderId"],
      shareBp: allocation.shareBp,
    })),
  };
}

function sealedNpwp(tenantId: string, shareholderId: string, npwp: string) {
  return {
    npwpSealed: sealSecret(
      npwp,
      `shareholder:${tenantId}:${shareholderId}:npwp`,
    ),
    npwpLast4: npwp.slice(-4),
  };
}

function sealedPayout(
  tenantId: string,
  shareholderId: string,
  account: NonNullable<CreateShareholderInput["payoutAccount"]>,
) {
  return {
    payoutBank: account.bank,
    payoutAccountSealed: sealSecret(
      account.accountNumber,
      `shareholder:${tenantId}:${shareholderId}:payout_account`,
    ),
    payoutAccountLast4: account.accountNumber.slice(-4),
    payoutAccountHolder: account.accountHolder,
  };
}

const clearedPayout = {
  payoutBank: null,
  payoutAccountSealed: null,
  payoutAccountLast4: null,
  payoutAccountHolder: null,
};

// ------------------------------------------------------- profit entities

export async function listProfitEntitiesService(
  context: ScopedTenantContext,
): Promise<ProfitEntity[]> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(profitEntities)
      .where(eq(profitEntities.tenantId, context.tenant.tenantId))
      .orderBy(asc(profitEntities.name), asc(profitEntities.id));
    return rows.map(toEntity);
  });
}

export async function createProfitEntityService(
  context: ScopedTenantContext,
  actorId: UserId,
  input: CreateProfitEntityInput,
): Promise<ProfitEntity> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      if (input.type === "legal_entity")
        await requireLegalEntity(tx, tenantId, input.legalEntityId!);
      else await requireOutlet(tx, tenantId, input.outletId!);
      const [row] = await tx
        .insert(profitEntities)
        .values({
          tenantId,
          name: input.name,
          type: input.type,
          legalEntityId: input.legalEntityId,
          outletId: input.outletId,
          basis: input.policy.basis,
          reserveBp: input.policy.reserveBp,
          frequency: input.policy.frequency,
          taxWithholdingBp: input.policy.taxWithholdingBp,
          createdBy: actorId,
        })
        .returning();
      if (!row) throw new Error("Profit entity insert returned no row");
      await auditAccountingChange(tx, context, {
        actorId,
        action: "profit_entity.created",
        objectType: "profit_entity",
        objectId: row.id,
        before: null,
        after: { type: row.type, isActive: row.isActive },
      });
      return toEntity(row);
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new HttpError(
        409,
        "CONFLICT",
        "This legal entity or outlet already has a profit entity.",
      );
    throw error;
  }
}

export async function updateProfitEntityService(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  input: UpdateProfitEntityInput,
): Promise<ProfitEntity> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(profitEntities)
      .where(
        and(
          eq(profitEntities.tenantId, context.tenant.tenantId),
          eq(profitEntities.id, profitEntityId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw notFound("Profit entity");
    const patch: Partial<typeof profitEntities.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.policy !== undefined) {
      patch.basis = input.policy.basis;
      patch.reserveBp = input.policy.reserveBp;
      patch.frequency = input.policy.frequency;
      patch.taxWithholdingBp = input.policy.taxWithholdingBp;
    }
    if (Object.keys(patch).length === 0) return toEntity(current);
    const [row] = await tx
      .update(profitEntities)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(profitEntities.tenantId, context.tenant.tenantId),
          eq(profitEntities.id, profitEntityId),
        ),
      )
      .returning();
    if (!row) throw new Error("Profit entity update returned no row");
    await auditAccountingChange(tx, context, {
      actorId,
      action: "profit_entity.updated",
      objectType: "profit_entity",
      objectId: row.id,
      before: { isActive: current.isActive },
      after: { isActive: row.isActive },
    });
    return toEntity(row);
  });
}

// ----------------------------------------------------------- shareholders

export async function listShareholdersService(
  context: ScopedTenantContext,
): Promise<Shareholder[]> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(shareholders)
      .where(eq(shareholders.tenantId, context.tenant.tenantId))
      .orderBy(asc(shareholders.name), asc(shareholders.id));
    return rows.map(toShareholder);
  });
}

const userLinkTaken = () =>
  new HttpError(
    409,
    "CONFLICT",
    "This login is already linked to another shareholder.",
  );

export async function createShareholderService(
  context: ScopedTenantContext,
  actorId: UserId,
  input: CreateShareholderInput,
): Promise<Shareholder> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const id = randomUUID();
  try {
    return await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .insert(shareholders)
        .values({
          tenantId,
          id,
          userId: input.userId,
          name: input.name,
          type: input.type,
          ...(input.npwp ? sealedNpwp(tenantId, id, input.npwp) : {}),
          ...(input.payoutAccount
            ? sealedPayout(tenantId, id, input.payoutAccount)
            : {}),
          createdBy: actorId,
        })
        .returning();
      if (!row) throw new Error("Shareholder insert returned no row");
      await auditAccountingChange(tx, context, {
        actorId,
        action: "shareholder.created",
        objectType: "shareholder",
        objectId: row.id,
        before: null,
        after: { type: row.type },
      });
      return toShareholder(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw userLinkTaken();
    throw error;
  }
}

export async function updateShareholderService(
  context: ScopedTenantContext,
  actorId: UserId,
  shareholderId: string,
  input: UpdateShareholderInput,
): Promise<Shareholder> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(shareholders)
        .where(
          and(
            eq(shareholders.tenantId, tenantId),
            eq(shareholders.id, shareholderId),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw notFound("Shareholder");
      if (input.userId !== undefined && input.userId !== current.userId)
        await requestRecipientChange(
          tx,
          context,
          actorId,
          current,
          input.userId,
        );
      const patch: Partial<typeof shareholders.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.type !== undefined) patch.type = input.type;
      // `userId` is not patched here: see `requestRecipientChange`.
      if (input.status !== undefined) patch.status = input.status;
      if (input.npwp !== undefined)
        Object.assign(
          patch,
          input.npwp === null
            ? { npwpSealed: null, npwpLast4: null }
            : sealedNpwp(tenantId, shareholderId, input.npwp),
        );
      if (input.payoutAccount !== undefined)
        Object.assign(
          patch,
          input.payoutAccount === null
            ? clearedPayout
            : sealedPayout(tenantId, shareholderId, input.payoutAccount),
        );
      if (Object.keys(patch).length === 0) return toShareholder(current);
      const [row] = await tx
        .update(shareholders)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(shareholders.tenantId, tenantId),
            eq(shareholders.id, shareholderId),
          ),
        )
        .returning();
      if (!row) throw new Error("Shareholder update returned no row");
      await auditAccountingChange(tx, context, {
        actorId,
        action: "shareholder.updated",
        objectType: "shareholder",
        objectId: row.id,
        before: { type: current.type },
        after: { type: row.type },
      });
      return toShareholder(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw userLinkTaken();
    throw error;
  }
}

// ------------------------------------------- shareholder recipient version

/**
 * Opens a recipient change for a shareholder whose row the caller has locked
 * FOR UPDATE: a pending version plus an approval chain. The row keeps its
 * current login until the chain's approved outcome is settled.
 *
 * The PATCH body has no idempotency key, so the key is derived from the
 * version number (`shareholder-recipient:<shareholderId>:<version>`, unique per
 * tenant). A repeat of the same PATCH while the change is pending is a replay
 * (no second version); another target while one is pending is 409.
 */
async function requestRecipientChange(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId,
  current: ShareholderRow,
  userId: string | null,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [open] = await tx
    .select()
    .from(shareholderRecipientVersions)
    .where(
      and(
        eq(shareholderRecipientVersions.tenantId, tenantId),
        eq(shareholderRecipientVersions.shareholderId, current.id),
        eq(shareholderRecipientVersions.status, "pending_approval"),
      ),
    )
    .limit(1);
  if (open) {
    if (open.userId === userId) return;
    throw new HttpError(
      409,
      "CONFLICT",
      "Another recipient change for this shareholder is waiting for approval.",
    );
  }
  if (userId !== null) {
    const [taken] = await tx
      .select({ id: shareholders.id })
      .from(shareholders)
      .where(
        and(
          eq(shareholders.tenantId, tenantId),
          eq(shareholders.userId, userId),
          ne(shareholders.id, current.id),
        ),
      )
      .limit(1);
    if (taken) throw userLinkTaken();
  }
  const [last] = await tx
    .select({ version: shareholderRecipientVersions.version })
    .from(shareholderRecipientVersions)
    .where(
      and(
        eq(shareholderRecipientVersions.tenantId, tenantId),
        eq(shareholderRecipientVersions.shareholderId, current.id),
      ),
    )
    .orderBy(desc(shareholderRecipientVersions.version))
    .limit(1);
  const version = (last?.version ?? 0) + 1;
  const idempotencyKey = `shareholder-recipient:${current.id}:${version}`;
  const id = randomUUID();
  // APPROVAL_POLICY_MISSING propagates: nobody may approve, fail closed.
  const opened = await openApprovalRequest(tx, context, {
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    actionType: "shareholder_version",
    objectType: SHAREHOLDER_RECIPIENT_OBJECT_TYPE,
    objectId: id,
    amountIdr: null,
    outletId: null,
    requestedBy: actorId,
    source: "user",
    requestReason: `Ganti penerima pernyataan pemegang saham ${current.name}`,
    idempotencyKey,
  });
  // A recipient change is never applied without a decision, even when the
  // matrix says no approval is needed: refuse instead of changing silently.
  if (!opened.required)
    throw new HttpError(
      409,
      "APPROVAL_REQUIRED",
      "Changing the login of a shareholder needs approval; the approval matrix asks for none, so the change was not made.",
    );
  await tx.insert(shareholderRecipientVersions).values({
    tenantId,
    id,
    shareholderId: current.id,
    version,
    previousUserId: current.userId,
    userId,
    approvalChainId: opened.chainId,
    requestedBy: actorId,
    idempotencyKey,
  });
  await auditAccountingChange(tx, context, {
    actorId,
    action: "shareholder.recipient_change_requested",
    objectType: SHAREHOLDER_RECIPIENT_OBJECT_TYPE,
    objectId: id,
    before: { shareholderId: current.id, userId: current.userId },
    after: { userId, version, status: "pending_approval" },
  });
}

/**
 * Applies the approval chain's outcome to a pending recipient version, on the
 * caller's transaction (the shareholder row, then the version, locked FOR
 * UPDATE, the same order as a PATCH). Idempotent: a version that is no longer
 * pending, or whose chain is still open, is returned unchanged. Used by the
 * `approval.resolved` consumer.
 *
 * - approved: the decider is the last level's `decidedBy` (never the
 *   requester). The change applies only while the shareholder still has the
 *   login it was requested against (else stale) and the new login is free
 *   (else the unique link conflicts); both reject the version with a note.
 * - rejected: rejected by that decider.
 * - expired or cancelled: `cancelled`. The table demands a decider for
 *   `rejected`, and nobody decided, so the status says "never decided".
 */
export async function settleShareholderRecipientVersionForApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  versionId: string,
  now = new Date(),
): Promise<RecipientVersionRow> {
  const tenantId = context.tenant.tenantId;
  const [header] = await tx
    .select({ shareholderId: shareholderRecipientVersions.shareholderId })
    .from(shareholderRecipientVersions)
    .where(
      and(
        eq(shareholderRecipientVersions.tenantId, tenantId),
        eq(shareholderRecipientVersions.id, versionId),
      ),
    )
    .limit(1);
  if (!header) throw notFound("Recipient version");
  const [holder] = await tx
    .select()
    .from(shareholders)
    .where(
      and(
        eq(shareholders.tenantId, tenantId),
        eq(shareholders.id, header.shareholderId),
      ),
    )
    .for("update")
    .limit(1);
  const [row] = await tx
    .select()
    .from(shareholderRecipientVersions)
    .where(
      and(
        eq(shareholderRecipientVersions.tenantId, tenantId),
        eq(shareholderRecipientVersions.id, versionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!holder || !row) throw notFound("Recipient version");
  if (row.status !== "pending_approval" || row.approvalChainId === null)
    return row;
  const chainId = row.approvalChainId;
  // Locks the chain head and applies the deadline atomically, so an inbox
  // decision in flight commits first; read the last level only afterwards.
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    now,
  });
  if (outcome === "pending") return row;
  const levels = await tx
    .select({ decidedBy: approvalRequests.decidedBy })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level));
  const [last] = levels;
  if (!last) throw notFound("Approval chain");
  const requester = row.requestedBy.toLowerCase();
  const decidedByRequester =
    last.decidedBy !== null && last.decidedBy.toLowerCase() === requester;
  // A sole Owner may have approved its own request at some level in the inbox
  // (founder decision 2026-11-10, legend-b8y6l). Re-checked here under the
  // Owner lock (taken after the chain head, the inbox order): a 2nd Owner
  // added since then cancels the request (fail closed).
  const requesterDecided = levels.some(
    (level) =>
      level.decidedBy !== null && level.decidedBy.toLowerCase() === requester,
  );
  const selfApproval: SelfApprovalBasis | null =
    outcome === "approved" && requesterDecided
      ? await lockAndCheckSoleOwnerSelfApproval(tx, tenantId, row.requestedBy)
      : null;
  const selfApprovalLost =
    outcome === "approved" && requesterDecided && selfApproval === null;
  const decider =
    last.decidedBy !== null &&
    !selfApprovalLost &&
    (!decidedByRequester || selfApproval !== null)
      ? userIdSchema.parse(last.decidedBy)
      : null;
  const close = async (
    status: RecipientVersionRow["status"],
    decidedBy: string | null,
    note: string,
    approvedBy: SelfApprovalBasis | null = null,
  ) => {
    const [updated] = await tx
      .update(shareholderRecipientVersions)
      .set({
        status,
        decidedBy,
        decidedAt: decidedBy === null ? null : now,
        decisionNote: note,
        updatedAt: now,
      })
      .where(
        and(
          eq(shareholderRecipientVersions.tenantId, tenantId),
          eq(shareholderRecipientVersions.id, versionId),
        ),
      )
      .returning();
    if (!updated) throw new Error("Recipient version update returned no row");
    await auditAccountingChange(tx, context, {
      actorId: decidedBy === null ? null : userIdSchema.parse(decidedBy),
      action: `shareholder.recipient_change_${status}`,
      objectType: SHAREHOLDER_RECIPIENT_OBJECT_TYPE,
      objectId: versionId,
      reason: note,
      before: { status: "pending_approval" },
      after:
        approvedBy === null ? { status } : { status, selfApproval: approvedBy },
    });
    return updated;
  };
  if (outcome === "cancelled" || outcome === "expired")
    return close("cancelled", null, `approval ${outcome}`);
  if (decider === null)
    return close(
      "cancelled",
      null,
      selfApprovalLost
        ? "approval self-approval no longer allowed: not sole owner"
        : "approval approver invalid",
    );
  if (outcome === "rejected")
    return close("rejected", decider, "approval rejected");
  // approved
  if (holder.userId !== row.previousUserId)
    return decidedByRequester
      ? close(
          "cancelled",
          null,
          "stale: the shareholder login changed since the request",
        )
      : close(
          "rejected",
          decider,
          "stale: the shareholder login changed since the request",
        );
  try {
    // Savepoint: a unique-link conflict leaves nothing half applied.
    await tx.transaction((sp) =>
      sp
        .update(shareholders)
        .set({ userId: row.userId, updatedAt: now })
        .where(
          and(
            eq(shareholders.tenantId, tenantId),
            eq(shareholders.id, holder.id),
          ),
        ),
    );
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    return decidedByRequester
      ? close(
          "cancelled",
          null,
          "the new login is already linked to another shareholder",
        )
      : close(
          "rejected",
          decider,
          "the new login is already linked to another shareholder",
        );
  }
  return selfApproval === null
    ? close("approved", decider, "approval approved")
    : close("approved", decider, "self-approval: sole owner", selfApproval);
}

// ------------------------------------------------------- share versions

const SELF_APPROVAL_REASON = "self-approval: sole owner";

async function lockEntity(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
): Promise<EntityRow> {
  const [row] = await tx
    .select()
    .from(profitEntities)
    .where(
      and(
        eq(profitEntities.tenantId, tenantId),
        eq(profitEntities.id, profitEntityId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw notFound("Profit entity");
  return row;
}

async function loadVersionRow(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
  version: number,
  lock = false,
): Promise<VersionRow> {
  const query = tx
    .select()
    .from(shareAllocationVersions)
    .where(
      and(
        eq(shareAllocationVersions.tenantId, tenantId),
        eq(shareAllocationVersions.profitEntityId, profitEntityId),
        eq(shareAllocationVersions.version, version),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Share allocation version");
  return row;
}

async function loadAllocations(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
  versions: readonly number[],
): Promise<AllocationRow[]> {
  if (versions.length === 0) return [];
  return tx
    .select()
    .from(shareAllocations)
    .where(
      and(
        eq(shareAllocations.tenantId, tenantId),
        eq(shareAllocations.profitEntityId, profitEntityId),
        inArray(shareAllocations.version, [...versions]),
      ),
    );
}

async function versionView(
  tx: TenantTransaction,
  row: VersionRow,
): Promise<ShareAllocationVersion> {
  const allocations = await loadAllocations(
    tx,
    row.tenantId,
    row.profitEntityId,
    [row.version],
  );
  return toVersion(row, allocations);
}

/** Every shareholder must exist in this tenant and be active (SH-03). */
async function assertShareholdersUsable(
  tx: TenantTransaction,
  tenantId: string,
  shareholderIds: readonly string[],
): Promise<void> {
  const rows = await tx
    .select({ id: shareholders.id })
    .from(shareholders)
    .where(
      and(
        eq(shareholders.tenantId, tenantId),
        inArray(shareholders.id, [...shareholderIds]),
        eq(shareholders.status, "active"),
      ),
    );
  if (rows.length !== new Set(shareholderIds).size)
    throw new HttpError(
      422,
      "SHAREHOLDER_NOT_USABLE",
      "Every shareholder must exist and be active.",
    );
}

async function latestApprovedEffectiveFrom(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
  excludeVersion: number | null,
): Promise<BusinessDate | null> {
  const filters: SQL[] = [
    eq(shareAllocationVersions.tenantId, tenantId),
    eq(shareAllocationVersions.profitEntityId, profitEntityId),
    eq(shareAllocationVersions.status, "approved"),
  ];
  if (excludeVersion !== null)
    filters.push(ne(shareAllocationVersions.version, excludeVersion));
  const [row] = await tx
    .select({ effectiveFrom: shareAllocationVersions.effectiveFrom })
    .from(shareAllocationVersions)
    .where(and(...filters))
    .orderBy(desc(shareAllocationVersions.effectiveFrom))
    .limit(1);
  return row?.effectiveFrom ?? null;
}

function insertAllocations(
  tx: TenantTransaction,
  tenantId: string,
  profitEntityId: string,
  version: number,
  allocations: CreateShareAllocationVersionInput["allocations"],
) {
  return tx
    .insert(shareAllocations)
    .values(
      allocations.map((allocation, position) => ({
        tenantId,
        profitEntityId,
        version,
        shareholderId: allocation.shareholderId,
        shareBp: allocation.shareBp,
        position,
      })),
    )
    .returning();
}

/** Same set of (shareholder, bp) rows, order aside. */
function sameAllocations(
  stored: readonly AllocationRow[],
  requested: CreateShareAllocationVersionInput["allocations"],
): boolean {
  if (stored.length !== requested.length) return false;
  const key = (row: { shareholderId: string; shareBp: number }) =>
    `${row.shareholderId.toLowerCase()}:${row.shareBp}`;
  const left = stored.map(key).sort();
  const right = requested.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

export async function listShareAllocationVersionsService(
  context: ScopedTenantContext,
  profitEntityId: string,
  query: { status?: ShareAllocationVersionStatus },
): Promise<ShareAllocationVersion[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [entity] = await tx
      .select({ id: profitEntities.id })
      .from(profitEntities)
      .where(
        and(
          eq(profitEntities.tenantId, tenantId),
          eq(profitEntities.id, profitEntityId),
        ),
      )
      .limit(1);
    if (!entity) throw notFound("Profit entity");
    const filters: SQL[] = [
      eq(shareAllocationVersions.tenantId, tenantId),
      eq(shareAllocationVersions.profitEntityId, profitEntityId),
    ];
    if (query.status)
      filters.push(eq(shareAllocationVersions.status, query.status));
    const rows = await tx
      .select()
      .from(shareAllocationVersions)
      .where(and(...filters))
      .orderBy(desc(shareAllocationVersions.version));
    const allocations = await loadAllocations(
      tx,
      tenantId,
      profitEntityId,
      rows.map((row) => row.version),
    );
    return rows.map((row) =>
      toVersion(
        row,
        allocations.filter((allocation) => allocation.version === row.version),
      ),
    );
  });
}

export async function getShareAllocationVersionService(
  context: ScopedTenantContext,
  profitEntityId: string,
  version: number,
): Promise<ShareAllocationVersion> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) =>
    versionView(
      tx,
      await loadVersionRow(
        tx,
        context.tenant.tenantId,
        profitEntityId,
        version,
      ),
    ),
  );
}

async function createVersionOnce(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  input: CreateShareAllocationVersionInput,
): Promise<ShareAllocationVersion> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await lockEntity(tx, tenantId, profitEntityId);

    // Replay: the key is unique per tenant, the body must match what it made.
    const [existing] = await tx
      .select()
      .from(shareAllocationVersions)
      .where(
        and(
          eq(shareAllocationVersions.tenantId, tenantId),
          eq(shareAllocationVersions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      const stored = await loadAllocations(
        tx,
        tenantId,
        existing.profitEntityId,
        [existing.version],
      );
      if (
        existing.profitEntityId !== profitEntityId ||
        existing.requestedBy !== actorId ||
        existing.effectiveFrom !== input.effectiveFrom ||
        !sameAllocations(stored, input.allocations)
      )
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used for a different request.",
        );
      return toVersion(existing, stored);
    }

    assertUniqueShareholders(input.allocations);
    await assertShareholdersUsable(
      tx,
      tenantId,
      input.allocations.map((allocation) => allocation.shareholderId),
    );
    assertEffectiveFromAdvances(
      await latestApprovedEffectiveFrom(tx, tenantId, profitEntityId, null),
      input.effectiveFrom,
    );

    const [last] = await tx
      .select({ version: shareAllocationVersions.version })
      .from(shareAllocationVersions)
      .where(
        and(
          eq(shareAllocationVersions.tenantId, tenantId),
          eq(shareAllocationVersions.profitEntityId, profitEntityId),
        ),
      )
      .orderBy(desc(shareAllocationVersions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;

    const [row] = await tx
      .insert(shareAllocationVersions)
      .values({
        tenantId,
        profitEntityId,
        version,
        effectiveFrom: input.effectiveFrom,
        requestedBy: actorId,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    if (!row) throw new Error("Share version insert returned no row");
    const allocations = await insertAllocations(
      tx,
      tenantId,
      profitEntityId,
      version,
      input.allocations,
    );
    await auditAccountingChange(tx, context, {
      actorId,
      action: "share_version.created",
      objectType: "share_allocation_version",
      objectId: profitEntityId,
      before: null,
      after: { version, count: allocations.length },
    });
    return toVersion(row, allocations);
  });
}

export async function createShareAllocationVersionService(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  input: CreateShareAllocationVersionInput,
): Promise<ShareAllocationVersion> {
  assertTrustedScopedContext(context);
  try {
    return await createVersionOnce(context, actorId, profitEntityId, input);
  } catch (error) {
    // Two concurrent creates with one key: the loser's insert hit the unique
    // key. Run again; the replay path now finds the winner's row.
    if (uniqueViolation(error))
      return createVersionOnce(context, actorId, profitEntityId, input);
    throw error;
  }
}

export async function updateShareAllocationVersionService(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  version: number,
  input: UpdateShareAllocationVersionInput,
): Promise<ShareAllocationVersion> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await lockEntity(tx, tenantId, profitEntityId);
    const row = await loadVersionRow(
      tx,
      tenantId,
      profitEntityId,
      version,
      true,
    );
    // Only the requester edits a draft; a submitted/decided version is frozen.
    if (row.status !== "draft") throw new AccountingError("INVALID_TRANSITION");
    if (row.requestedBy !== actorId) throw new AccessError("PERMISSION_DENIED");

    if (input.allocations !== undefined) {
      assertUniqueShareholders(input.allocations);
      await assertShareholdersUsable(
        tx,
        tenantId,
        input.allocations.map((allocation) => allocation.shareholderId),
      );
    }
    if (input.effectiveFrom !== undefined)
      assertEffectiveFromAdvances(
        await latestApprovedEffectiveFrom(tx, tenantId, profitEntityId, null),
        input.effectiveFrom,
      );
    if (input.effectiveFrom === undefined && input.allocations === undefined)
      return versionView(tx, row);

    let updated = row;
    if (input.effectiveFrom !== undefined) {
      const [next] = await tx
        .update(shareAllocationVersions)
        .set({ effectiveFrom: input.effectiveFrom, updatedAt: new Date() })
        .where(
          and(
            eq(shareAllocationVersions.tenantId, tenantId),
            eq(shareAllocationVersions.profitEntityId, profitEntityId),
            eq(shareAllocationVersions.version, version),
          ),
        )
        .returning();
      if (!next) throw new Error("Share version update returned no row");
      updated = next;
    }
    let allocations: AllocationRow[];
    if (input.allocations !== undefined) {
      // Deleting a draft's rows is the one delete the database allows.
      await tx
        .delete(shareAllocations)
        .where(
          and(
            eq(shareAllocations.tenantId, tenantId),
            eq(shareAllocations.profitEntityId, profitEntityId),
            eq(shareAllocations.version, version),
          ),
        );
      allocations = await insertAllocations(
        tx,
        tenantId,
        profitEntityId,
        version,
        input.allocations,
      );
    } else {
      allocations = await loadAllocations(tx, tenantId, profitEntityId, [
        version,
      ]);
    }
    await auditAccountingChange(tx, context, {
      actorId,
      action: "share_version.updated",
      objectType: "share_allocation_version",
      objectId: profitEntityId,
      before: null,
      after: { version, count: allocations.length },
    });
    return toVersion(updated, allocations);
  });
}

async function applyTransition(
  tx: TenantTransaction,
  row: VersionRow,
  allocations: readonly AllocationRow[],
  result: {
    status: ShareAllocationVersionStatus;
    decidedBy: UserId | null;
    decidedAt: IsoDateTime | null;
    decisionNote: string | null;
  },
): Promise<ShareAllocationVersion> {
  const [next] = await tx
    .update(shareAllocationVersions)
    .set({
      status: result.status,
      decidedBy: result.decidedBy,
      decidedAt: result.decidedAt ? new Date(result.decidedAt) : null,
      decisionNote: result.decisionNote,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(shareAllocationVersions.tenantId, row.tenantId),
        eq(shareAllocationVersions.profitEntityId, row.profitEntityId),
        eq(shareAllocationVersions.version, row.version),
      ),
    )
    .returning();
  if (!next) throw new Error("Share version transition returned no row");
  return toVersion(next, allocations);
}

/** Approval request opened for a submitted share version (matrix `shareholder_version`). */
function openShareVersionApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  requestedBy: string,
  entity: EntityRow,
  row: VersionRow,
) {
  return openApprovalRequest(tx, context, {
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    actionType: "shareholder_version",
    objectType: SHARE_ALLOCATION_VERSION_OBJECT_TYPE,
    objectId: row.id,
    amountIdr: null,
    outletId: entity.outletId,
    requestedBy: userIdSchema.parse(requestedBy),
    source: "user",
    requestReason: `Versi porsi saham ${entity.name} v${row.version}`,
  });
}

/**
 * The latest approval chain opened for a share version (level-1 row id), or
 * null when the matrix needed none. No column on the version: the chain is
 * found by (tenant, source module, object type, object id).
 */
async function shareVersionChainOf(
  tx: TenantTransaction,
  tenantId: TenantId,
  versionId: string,
): Promise<string | null> {
  const [head] = await tx
    .select({ chainId: approvalRequests.chainId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.sourceModule, PROFIT_SHARE_APPROVAL_SOURCE_MODULE),
        eq(approvalRequests.objectType, SHARE_ALLOCATION_VERSION_OBJECT_TYPE),
        eq(approvalRequests.objectId, versionId),
        eq(approvalRequests.level, 1),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return head?.chainId ?? null;
}

/**
 * Applies the approval chain's outcome to a pending share version already
 * loaded and locked (entity first, then the version). Idempotent: a version
 * that is no longer pending, has no chain, or whose chain is still open is
 * returned unchanged.
 *
 * - approved: the decider is the last level's `decidedBy` (never the
 *   requester). The contract guards (sum, unique shareholders, effective date
 *   after the latest approved version) run again; a refusal rejects the
 *   version with a note instead of approving it.
 * - rejected: rejected by that decider.
 * - expired or cancelled: `cancelled` (nobody decided).
 */
async function settleLoadedShareVersion(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: VersionRow,
  now: Date,
): Promise<ShareAllocationVersion> {
  const tenantId = context.tenant.tenantId;
  const allocations = await loadAllocations(tx, tenantId, row.profitEntityId, [
    row.version,
  ]);
  if (row.status !== "pending_approval") return toVersion(row, allocations);
  const chainId = await shareVersionChainOf(tx, tenantId, row.id);
  if (chainId === null) return toVersion(row, allocations);
  // Locks the chain head and applies the deadline atomically, so an inbox
  // decision in flight commits first; read the last level only afterwards.
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    now,
  });
  if (outcome === "pending") return toVersion(row, allocations);
  const levels = await tx
    .select({ decidedBy: approvalRequests.decidedBy })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level));
  const [last] = levels;
  if (!last) throw notFound("Approval chain");
  const requester = row.requestedBy.toLowerCase();
  const decidedByRequester =
    last.decidedBy !== null && last.decidedBy.toLowerCase() === requester;
  // A sole Owner may have approved its own request at some level in the inbox
  // (founder decision 2026-11-10, legend-b8y6l). Re-checked here under the
  // Owner lock (taken after the chain head, the inbox order): a 2nd Owner
  // added since then cancels the request (fail closed).
  const requesterDecided = levels.some(
    (level) =>
      level.decidedBy !== null && level.decidedBy.toLowerCase() === requester,
  );
  const selfApproval: SelfApprovalBasis | null =
    outcome === "approved" && requesterDecided
      ? await lockAndCheckSoleOwnerSelfApproval(tx, tenantId, row.requestedBy)
      : null;
  const selfApprovalLost =
    outcome === "approved" && requesterDecided && selfApproval === null;
  const decider =
    last.decidedBy !== null &&
    !selfApprovalLost &&
    (!decidedByRequester || selfApproval !== null)
      ? userIdSchema.parse(last.decidedBy)
      : null;
  const nowIso = now.toISOString() as IsoDateTime;
  const close = async (
    status: "approved" | "rejected" | "cancelled",
    decidedBy: UserId | null,
    note: string | null,
    reason: string | null,
  ) => {
    const view = await applyTransition(tx, row, allocations, {
      status,
      decidedBy,
      decidedAt: decidedBy === null ? null : nowIso,
      decisionNote: note,
    });
    await auditAccountingChange(tx, context, {
      actorId: decidedBy,
      action: `share_version.${status}`,
      objectType: "share_allocation_version",
      objectId: row.profitEntityId,
      reason,
      before: { status: "pending_approval" },
      after: { version: row.version, count: allocations.length, status },
    });
    return view;
  };
  if (outcome === "cancelled" || outcome === "expired")
    return close("cancelled", null, null, `approval ${outcome}`);
  if (decider === null)
    return close(
      "cancelled",
      null,
      null,
      selfApprovalLost
        ? "approval self-approval no longer allowed: not sole owner"
        : "approval approver invalid",
    );
  if (outcome === "rejected")
    return close("rejected", decider, "approval rejected", "approval rejected");
  // approved
  try {
    // Savepoint: a refused guard leaves nothing half applied.
    const approved = await tx.transaction(async (sp) => {
      const result = transitionShareAllocationVersion(
        transitionState(row, allocations),
        selfApproval === null
          ? { type: "approve", actorId: decider, now: nowIso }
          : { type: "approve", actorId: decider, now: nowIso, selfApproval },
      );
      assertEffectiveFromAdvances(
        await latestApprovedEffectiveFrom(
          sp,
          tenantId,
          row.profitEntityId,
          row.version,
        ),
        row.effectiveFrom,
      );
      return applyTransition(sp, row, allocations, result);
    });
    await auditAccountingChange(tx, context, {
      actorId: decider,
      action: "share_version.approved",
      objectType: "share_allocation_version",
      objectId: row.profitEntityId,
      reason: selfApproval === null ? null : SELF_APPROVAL_REASON,
      before: { status: "pending_approval" },
      after: {
        version: row.version,
        count: allocations.length,
        status: "approved",
        ...(selfApproval === null ? {} : { selfApproval }),
      },
    });
    return approved;
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    const note = `approval refused: ${error.code}`;
    // A self-approved version cannot be recorded as rejected by its own
    // requester (four-eyes CHECK): it is cancelled instead (legend-b8y6l).
    return decidedByRequester
      ? close("cancelled", null, null, note)
      : close("rejected", decider, note, note);
  }
}

/**
 * Applies the approval chain's outcome to a share version, on the caller's
 * transaction (entity, then the version, locked FOR UPDATE, the same order as
 * decide). Used by the `approval.resolved` consumer.
 */
export async function settleShareAllocationVersionForApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  profitEntityId: string,
  version: number,
  now = new Date(),
): Promise<ShareAllocationVersion> {
  const tenantId = context.tenant.tenantId;
  await lockEntity(tx, tenantId, profitEntityId);
  const row = await loadVersionRow(tx, tenantId, profitEntityId, version, true);
  return settleLoadedShareVersion(tx, context, row, now);
}

export async function submitShareAllocationVersionService(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  version: number,
  input: { idempotencyKey: string },
): Promise<ShareAllocationVersion> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const entity = await lockEntity(tx, tenantId, profitEntityId);
    const row = await loadVersionRow(
      tx,
      tenantId,
      profitEntityId,
      version,
      true,
    );
    const allocations = await loadAllocations(tx, tenantId, profitEntityId, [
      version,
    ]);
    // The key is claimed before the transition: a replay returns the current
    // state, a new key on a version that already moved is INVALID_TRANSITION.
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "share_version.submit",
      targetId: `${profitEntityId}:${version}`,
      actorId,
      request: {},
    });
    if (claim === "replay") return toVersion(row, allocations);
    const result = transitionShareAllocationVersion(
      transitionState(row, allocations),
      { type: "submit", actorId },
    );
    const view = await applyTransition(tx, row, allocations, result);
    // The tenant's approval matrix (`shareholder_version`) decides who
    // approves and in how many levels; the permission alone never does.
    // APPROVAL_POLICY_MISSING propagates: nobody may approve, fail closed.
    // `required: false` keeps the direct decide path (distribution parity).
    await openShareVersionApproval(tx, context, actorId, entity, row);
    await auditAccountingChange(tx, context, {
      actorId,
      action: "share_version.submitted",
      objectType: "share_allocation_version",
      objectId: profitEntityId,
      before: null,
      after: { version, count: allocations.length },
    });
    return view;
  });
}

export async function decideShareAllocationVersionService(
  context: ScopedTenantContext,
  actorId: UserId,
  profitEntityId: string,
  version: number,
  input: ShareVersionDecisionInput,
): Promise<ShareAllocationVersion> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  // Opening a chain here must commit before the 409 is answered, so the
  // answer is thrown after the transaction instead of inside it.
  let chainOpenedNow = false;
  const decided = await withTenant(db, context, async (tx) => {
    const entity = await lockEntity(tx, tenantId, profitEntityId);
    const row = await loadVersionRow(
      tx,
      tenantId,
      profitEntityId,
      version,
      true,
    );
    const allocations = await loadAllocations(tx, tenantId, profitEntityId, [
      version,
    ]);
    // Claimed before the transition (see submit).
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "share_version.decide",
      targetId: `${profitEntityId}:${version}`,
      actorId,
      request: { decision: input.decision, note: input.note },
    });
    if (claim === "replay") return toVersion(row, allocations);

    const now = new Date();
    const nowIso = now.toISOString() as IsoDateTime;
    const state = transitionState(row, allocations);
    const chainId = await shareVersionChainOf(tx, tenantId, row.id);
    // Sole-Owner self-approval (founder decision 2026-11-10, legend-b8y6l).
    // Without a chain this call decides: the Owner lock is taken here (no
    // chain row is locked). With a chain this call only settles, and the
    // settle re-checks under the lock after the chain head (the inbox order),
    // so here an unlocked preview only decides whether the requester guard
    // below still answers 403 (2+ Owners keep the old answer).
    const selfRequested =
      input.decision === "approve" &&
      actorId.toLowerCase() === row.requestedBy.toLowerCase();
    const selfApproval: SelfApprovalBasis | null =
      selfRequested && chainId === null
        ? await lockAndCheckSoleOwnerSelfApproval(tx, tenantId, actorId)
        : null;
    const settlesOwnChain =
      selfRequested &&
      chainId !== null &&
      (await soleOwnerSelfApprovalPreview(tx, tenantId, actorId));
    // Same guards as the direct path: pending status and requester != caller.
    const result = transitionShareAllocationVersion(
      state,
      input.decision === "approve"
        ? selfApproval === null && !settlesOwnChain
          ? { type: "approve", actorId, now: nowIso }
          : {
              type: "approve",
              actorId,
              now: nowIso,
              selfApproval: selfApproval ?? "sole_owner",
            }
        : { type: "reject", actorId, now: nowIso, reason: input.note ?? "" },
    );
    if (input.decision === "approve") {
      if (chainId === null) {
        // Submit found no tier (or this is a version submitted before the
        // matrix applied). The matrix may have tightened since: ask it again
        // with the same open path before approving directly. A chain opened
        // now is the requester's, like at submit.
        const opened = await openShareVersionApproval(
          tx,
          context,
          row.requestedBy,
          entity,
          row,
        );
        if (opened.required) {
          chainOpenedNow = true;
          return toVersion(row, allocations);
        }
      } else {
        // A chain decides: this call only settles it (the approver is the
        // last level's user), or answers 409 while levels are still open.
        const settled = await settleLoadedShareVersion(tx, context, row, now);
        if (settled.status === "pending_approval")
          throw new HttpError(
            409,
            "APPROVAL_PENDING",
            "Persetujuan belum selesai di kotak masuk approval.",
          );
        return settled;
      }
      // A replacement must start after the latest approved version (checked
      // again here: another version may have been approved since submit).
      assertEffectiveFromAdvances(
        await latestApprovedEffectiveFrom(
          tx,
          tenantId,
          profitEntityId,
          version,
        ),
        row.effectiveFrom,
      );
    } else if (chainId !== null) {
      // An open chain is cancelled first; one that already ended "approved"
      // cannot be rejected any more: the decision exists, settle applies it.
      const outcome = await cancelApprovalRequest(tx, context, {
        chainId,
        sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
        actorUserId: actorId,
        now,
      });
      if (outcome === "approved")
        throw new AccountingError("INVALID_TRANSITION");
      // A chain that already ended rejected or expired before the consumer
      // ran: record that outcome (the inbox decider, or cancelled), not the
      // caller's reject.
      if (outcome === "rejected" || outcome === "expired")
        return settleLoadedShareVersion(tx, context, row, now);
    }
    const view = await applyTransition(tx, row, allocations, result);
    await auditAccountingChange(tx, context, {
      actorId,
      action:
        input.decision === "approve"
          ? "share_version.approved"
          : "share_version.rejected",
      objectType: "share_allocation_version",
      objectId: profitEntityId,
      reason:
        input.decision === "reject"
          ? input.note
          : selfApproval === null
            ? null
            : SELF_APPROVAL_REASON,
      before: null,
      after: {
        version,
        count: allocations.length,
        ...(selfApproval === null ? {} : { selfApproval }),
      },
    });
    return view;
  });
  if (chainOpenedNow)
    throw new HttpError(
      409,
      "APPROVAL_PENDING",
      "Persetujuan belum selesai di kotak masuk approval.",
    );
  return decided;
}
