// Nightly reconciliation of the trusted payout boundary (bead legend-i01jp;
// design docs/briefs/905/design.md "Recon malam").
//
// The database functions of migrations 0410-0413 are the only writers of a
// correction, an overpaid record, a return and a recorded posting source. What
// SQL cannot prove (a human identity: user, session and role rows are writable
// by the app role; the bytes of a proof; the bank transfer itself) is checked
// here after the fact, read-only, and every difference is flagged:
// - for each corrected / overpaid / returned item: two attestations by two
//   people from two different sessions; every session matches its snapshot and
//   its MFA was fresh; two audit rows of the same people; exactly one proof
//   binding (not a legacy duplicate, not contested); the stored proof file
//   read again and hashed matches its record; the journal exists, is not
//   reversed and its debit equals the decrypted net of the item (or of the
//   settle group, for a correction);
// - for each overpaid / returned item without such an operation (moved there
//   by a direct write): flagged `operation_missing`;
// - for each recorded posting source: its attestation, session and audit row;
// - for each overpaid item whose posting carries a fee: the fee journal
//   (`payroll-payout-overpaid-fee:<item>`) exists and is not reversed (990-B);
// - for each proof closure made since the boundary: both attestations (propose,
//   and approve once closed) of the people the closure names, from live MFA
//   sessions, under a grant bound to the key (990-C);
// - every resolve / bank_confirm / closure attestation, with or without another
//   operation on its batch, and the grant it was made under: the grant must
//   match the attestation's item set, detail and ref (990-D).
// A difference calls `app.payout_recon_flag` (insert-only) once per item and
// reason; the flag holds the payslip's retry and is listed as the finance
// exception `payout_recon_flag`. Operations that finished before
// `app.payout_trusted_since()` (the time migration 0410 was applied) came from
// before the trusted boundary and are not checked. Nothing here changes
// an item, a posting or a journal, and the log carries counts only.

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import type { ScopedTenantContext, TenantId } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
  payrollPayoutGlPostings,
} from "../db/schema/payroll-payout.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "./hris-access.ts";
import { payrollGlKeys } from "./payroll-gl-consumer.ts";
import { payoutGlKeys } from "./payroll-payout-gl.service.ts";
import {
  overpaidFeeJournalKey,
  overpaidJournalKey,
} from "./payroll-payout-overpaid.service.ts";
import { openItemAmount, openItemFee } from "./payroll-payout.service.ts";
import { accountingEnabled } from "./payroll-payout-setup.ts";
import { itemSetHashOf } from "./payroll-payout-proof-binding.service.ts";
import { sha256Of } from "./payroll-payout-proof-fingerprint.service.ts";

export type PayoutReconKind =
  "correction" | "overpaid" | "return" | "posting_source";

/** Kinds a flag can carry: the operations above plus the grant-checked steps. */
export type PayoutReconFlagKind =
  PayoutReconKind | "closure" | "resolve" | "bank_confirm" | "batch_approve";

export type PayoutReconReason =
  | "attestation_count"
  | "attestation_same_person"
  | "attestation_same_session"
  | "session_mismatch"
  | "mfa_stale"
  | "audit_mismatch"
  | "binding_missing"
  | "binding_mismatch"
  | "binding_duplicate"
  | "binding_contested"
  | "evidence_record_missing"
  | "evidence_missing"
  | "evidence_hash_mismatch"
  | "posting_missing"
  | "journal_missing"
  | "journal_reversed"
  | "net_unreadable"
  | "net_mismatch"
  | "fee_sealed_mismatch"
  | "fee_journal_amount"
  | "operation_missing"
  | "grant_missing"
  | "grant_mismatch"
  | "closure_actor_mismatch"
  | "closure_session_mismatch";

/** MFA must be at most this old when the step was attested. */
const MFA_MAX_AGE_MS = 15 * 60_000;
/** Clock skew allowed on top of the MFA age limit. */
const MFA_AGE_TOLERANCE_MS = 2 * 60_000;

export const PAYOUT_RECON_OPERATIONS_PER_PAGE = 200;

export type PayoutReconPageResult = {
  /** Operations checked in this page. */
  readonly operations: number;
  /** New flags written. */
  readonly flagged: number;
  /** Known flags raised again (a changed fingerprint records a sighting). */
  readonly reraised: number;
  /** Known flags whose chunk failed to be raised again; logged, page not failed. */
  readonly reraiseFailed: number;
  /** Proof files that could not be read for a reason other than "not found". */
  readonly unreadable: number;
  /** Sort key of the last operation of the page; null when the page was empty. */
  readonly last: string | null;
  /** True when no operation is left after this page. */
  readonly exhausted: boolean;
};

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  (result as { rows: Row[] }).rows ?? [];

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const millis = (value: unknown): number | null =>
  value === null || value === undefined
    ? null
    : new Date(value as string | Date).getTime();
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/** `IN (...)` list of parameters; callers never pass an empty list. */
const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

type Operation = {
  kind: PayoutReconKind;
  operationId: string;
  batchId: string;
  evidenceKey: string | null;
  sortKey: string;
  /** Every item of the operation (the item-set hash covers them all). */
  itemIds: string[];
  /** Items that reached their final state through the trusted functions. */
  terminalItemIds: string[];
  /**
   * An overpaid / returned item with no recorded proposal or consumed claim:
   * the operation id is the item id and nothing else is checked.
   */
  missing: boolean;
};

/** The operations after `after`, in a stable order, newest rule set first. */
async function listOperations(
  tx: Tx,
  tenantId: string,
  options: { after: string | null; limit: number; since: Date },
): Promise<Operation[]> {
  const since = options.since.toISOString();
  const rows = rowsOf(
    await tx.execute(sql`
      SELECT * FROM (
        SELECT 'correction'::text AS kind, c.operation_id::text AS operation_id,
               c.batch_id::text AS batch_id, min(c.evidence_key) AS evidence_key,
               array_agg(c.item_id::text ORDER BY c.item_id) AS item_ids,
               coalesce(array_agg(c.item_id::text ORDER BY c.item_id)
                 FILTER (WHERE c.status = 'corrected'), ARRAY[]::text[]) AS terminal_item_ids,
               'correction:' || c.operation_id::text AS sort_key,
               false AS missing
          FROM payroll_payout_failed_corrections c
         WHERE c.tenant_id = ${tenantId}::uuid
         GROUP BY c.operation_id, c.batch_id
        HAVING bool_or(c.status = 'corrected') AND max(c.corrected_at) >= ${since}::timestamptz
        UNION ALL
        SELECT 'overpaid'::text, (array_agg(p.id ORDER BY p.id))[1]::text,
               p.batch_id::text, p.evidence_key,
               array_agg(p.item_id::text ORDER BY p.item_id),
               coalesce(array_agg(p.item_id::text ORDER BY p.item_id)
                 FILTER (WHERE p.status = 'recorded'), ARRAY[]::text[]),
               'overpaid:' || (array_agg(p.id ORDER BY p.id))[1]::text, false
          FROM payroll_payout_overpaid_proposals p
         WHERE p.tenant_id = ${tenantId}::uuid
         GROUP BY p.batch_id, p.evidence_key
        HAVING bool_or(p.status = 'recorded') AND max(p.recorded_at) >= ${since}::timestamptz
        UNION ALL
        SELECT 'return'::text, c.id::text, c.batch_id::text, c.evidence_key,
               coalesce((SELECT array_agg(i.id::text ORDER BY i.id)
                           FROM payroll_disbursement_items i
                          WHERE i.tenant_id = c.tenant_id AND i.return_claim_id = c.id), ARRAY[]::text[]),
               coalesce((SELECT array_agg(i.id::text ORDER BY i.id)
                           FROM payroll_disbursement_items i
                          WHERE i.tenant_id = c.tenant_id AND i.return_claim_id = c.id
                            AND i.status = 'returned'), ARRAY[]::text[]),
               'return:' || c.id::text, false
          FROM payroll_payout_return_claims c
         WHERE c.tenant_id = ${tenantId}::uuid AND c.status = 'consumed'
           AND c.consumed_at >= ${since}::timestamptz
        UNION ALL
        SELECT 'posting_source'::text, p.id::text, p.batch_id::text, NULL::text,
               ARRAY[]::text[], ARRAY[]::text[], 'posting_source:' || p.id::text,
               false
          FROM payroll_payout_gl_postings p
         WHERE p.tenant_id = ${tenantId}::uuid
           AND (EXISTS (SELECT 1 FROM payroll_payout_attestations a
                         WHERE a.tenant_id = p.tenant_id AND a.kind = 'posting_source'
                           AND a.operation_id = p.id)
                OR EXISTS (SELECT 1 FROM audit_logs al
                            WHERE al.tenant_id = p.tenant_id
                              AND al.created_at >= ${since}::timestamptz
                              AND al.event->>'action' = 'payroll.disbursement.posting_source_recorded'
                              AND al.event #>> '{maskedChanges,after,postingId}' = p.id::text)
                -- A source on a cash / unfrozen bank settlement that nobody
                -- attested and that is not the mapped account (a direct write).
                OR (p.posted_at >= ${since}::timestamptz
                    AND p.kind IN ('settle', 'settle_pending', 'settle_skipped')
                    AND p.source_gl_account_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM payroll_disbursement_batches b
                       WHERE b.tenant_id = p.tenant_id AND b.id = p.batch_id
                         AND (b.channel = 'cash' OR b.source_bank_account_id IS NULL)
                         AND p.source_gl_account_id IS DISTINCT FROM (
                           CASE WHEN b.channel = 'cash'
                             THEN (SELECT m.account_id FROM account_mappings m
                                    WHERE m.tenant_id = b.tenant_id
                                      AND m.legal_entity_id = b.legal_entity_id
                                      AND m.role = 'petty_cash')
                             ELSE (SELECT ba.gl_account_id
                                     FROM payroll_payout_configs c
                                     JOIN bank_accounts ba
                                       ON ba.tenant_id = c.tenant_id
                                      AND ba.legal_entity_id = c.legal_entity_id
                                      AND ba.id = c.manual_source_bank_account_id
                                    WHERE c.tenant_id = b.tenant_id
                                      AND c.legal_entity_id = b.legal_entity_id)
                           END))))
        UNION ALL
        -- Every overpaid / returned item, not only those with an operation row:
        -- one moved there after the boundary without a recorded proposal or a
        -- consumed claim bypassed the trusted functions.
        SELECT CASE WHEN i.status = 'overpaid' THEN 'overpaid' ELSE 'return' END::text,
               i.id::text, i.batch_id::text, NULL::text,
               ARRAY[i.id::text], ARRAY[i.id::text], 'missing:' || i.id::text, true
          FROM payroll_disbursement_items i
         WHERE i.tenant_id = ${tenantId}::uuid
           AND i.status IN ('overpaid', 'returned')
           AND i.updated_at >= ${since}::timestamptz
           AND NOT (CASE WHEN i.status = 'overpaid'
             THEN EXISTS (SELECT 1 FROM payroll_payout_overpaid_proposals p
                           WHERE p.tenant_id = i.tenant_id AND p.item_id = i.id
                             AND p.status = 'recorded')
             ELSE EXISTS (SELECT 1 FROM payroll_payout_return_claims c
                           WHERE c.tenant_id = i.tenant_id AND c.id = i.return_claim_id
                             AND c.status = 'consumed')
           END)
      ) ops
      WHERE ${options.after === null ? sql`TRUE` : sql`ops.sort_key > ${options.after}`}
      ORDER BY ops.sort_key
      LIMIT ${options.limit}
    `),
  );
  return rows.map((row) => ({
    kind: String(row.kind) as PayoutReconKind,
    operationId: String(row.operation_id),
    batchId: String(row.batch_id),
    evidenceKey: text(row.evidence_key),
    sortKey: String(row.sort_key),
    itemIds: list(row.item_ids),
    terminalItemIds: list(row.terminal_item_ids),
    missing: row.missing === true,
  }));
}

type Attestation = {
  kind: string;
  operationId: string;
  batchId: string;
  evidenceKey: string | null;
  itemIds: string[];
  actor: string;
  sessionId: string;
  sessionCreatedAt: number | null;
  mfaVerifiedAt: number | null;
  attestedAt: number | null;
  step: string;
  grantId: string | null;
  txid: number | null;
};

/** Non-secret columns of a step grant (the app role reads nothing else). */
type GrantRow = {
  kind: string;
  step: string;
  actor: string;
  sessionId: string;
  batchId: string | null;
  itemSetHash: string | null;
  evidenceKey: string | null;
  refId: string | null;
  detail: string | null;
  expiresAt: number | null;
  consumedAt: number | null;
  consumedTxid: number | null;
};

/**
 * What an item holds of its resolution: the outcome and first resolver now on
 * the item, its status, and the last propose step made for it (a proposal can
 * be withdrawn and made again with another outcome).
 */
type ResolutionFacts = {
  outcome: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedBy2: string | null;
  lastProposeOperationId: string | null;
  /** Every propose / approve attestation of the item, whenever it was made. */
  steps: {
    step: string;
    actor: string;
    sessionId: string;
    operationId: string;
  }[];
};

type SessionRow = {
  userId: string;
  createdAt: number | null;
  mfaVerifiedAt: number | null;
};

type Binding = {
  kind: string;
  batchId: string;
  itemSetHash: string;
  evidenceKey: string;
  contentSha256: string;
  storedSha256: string;
  legacyDuplicate: boolean;
  createdBy: string;
};

type FileRecord = {
  content: string;
  stored: string | null;
  /** Batch the proof was uploaded for. */
  batchId: string;
};

type AuditRow = {
  action: string;
  objectId: string | null;
  evidenceKey: string | null;
  postingId: string | null;
  by: string | null;
};

type Journal = { id: string; debit: bigint; reversed: boolean };

type ItemFacts = {
  id: string;
  payslipId: string;
  glPostingId: string | null;
  net: number | null;
  /** Decrypted sealed fee; null when it cannot be read (fail closed). */
  fee: number | null;
};

/** Everything one page needs, read in one tenant transaction. */
type Facts = {
  attestations: Attestation[];
  /** Grants of the attestations made at or after the grant cutover. */
  grants: Map<string, GrantRow>;
  grantsSince: number | null;
  sessions: Map<string, SessionRow>;
  bindings: Binding[];
  contested: Map<string, boolean>;
  /** Per key: every hash of its binding is still claimed by that binding. */
  hashesHeld: Map<string, boolean>;
  records: Map<string, FileRecord>;
  audits: AuditRow[];
  journals: Map<string, Journal>;
  items: Map<string, ItemFacts>;
  postings: Map<
    string,
    { kind: string; journalKey: string; feeIdr: number | null }
  >;
  /** Resolution state of the items of the resolve attestations. */
  resolutions: Map<string, ResolutionFacts>;
  /** Item ids linked to each posting (a settle group), with their nets. */
  groups: Map<string, ItemFacts[]>;
  runOfBatch: Map<string, string>;
  /**
   * Items a posting source holds when it is flagged (a flag names an item, so
   * the payslip is held): the items linked to the posting, else every paid
   * item of its batch (the most restrictive choice).
   */
  sourceItems: Map<string, string[]>;
  /** Pairs that already carry a flag (kind, operation, item, reason). */
  flagged: Set<string>;
  /** The tenant's accounting module is on (a zero posted fee is legit only when off). */
  accountingOn: boolean;
};

const AUDIT_ACTIONS = {
  correction: [
    "payroll.disbursement.correction_proposed",
    "payroll.disbursement.item_corrected",
  ],
  overpaid: [
    "payroll.disbursement.overpaid_proposed",
    "payroll.disbursement.item_overpaid",
  ],
  return: ["payroll.disbursement.manual_returned"],
  posting_source: ["payroll.disbursement.posting_source_recorded"],
} as const satisfies Record<PayoutReconKind, readonly string[]>;

const flagKey = (
  kind: string,
  operationId: string,
  itemId: string | null,
  reason: string,
) => `${kind}|${operationId}|${itemId ?? ""}|${reason}`;

/** `uuid` parameter list for an `IN (...)`; callers never pass an empty list. */
const uuidList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  );

async function readAttestations(
  tx: Tx,
  tenantId: TenantId,
  condition: SQL,
): Promise<Attestation[]> {
  return rowsOf(
    await tx.execute(sql`
      SELECT a.kind, a.operation_id::text AS operation_id, a.batch_id::text AS batch_id,
             a.evidence_key, a.item_ids::text[] AS item_ids, a.actor, a.session_id,
             a.session_created_at, a.mfa_verified_at, a.attested_at,
             a.step, a.grant_id::text AS grant_id, a.txid
        FROM payroll_payout_attestations a
       WHERE a.tenant_id = ${tenantId}::uuid
         AND ${condition}`),
  ).map((row): Attestation => ({
    kind: String(row.kind),
    operationId: String(row.operation_id),
    batchId: String(row.batch_id),
    evidenceKey: text(row.evidence_key),
    itemIds: list(row.item_ids),
    actor: String(row.actor),
    sessionId: String(row.session_id),
    sessionCreatedAt: millis(row.session_created_at),
    mfaVerifiedAt: millis(row.mfa_verified_at),
    attestedAt: millis(row.attested_at),
    step: String(row.step),
    grantId: text(row.grant_id),
    txid: row.txid === null || row.txid === undefined ? null : Number(row.txid),
  }));
}

/** The resolution state of each item of a resolve attestation. */
async function readResolutions(
  tx: Tx,
  tenantId: TenantId,
  attestations: readonly Attestation[],
): Promise<Map<string, ResolutionFacts>> {
  const resolutions = new Map<string, ResolutionFacts>();
  const ids = [
    ...new Set(
      attestations.flatMap((a) => (a.kind === "resolve" ? a.itemIds : [])),
    ),
  ];
  if (ids.length === 0) return resolutions;
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT i.id::text AS id, i.resolution_outcome, i.status, i.resolved_by,
             i.resolved_by_2
        FROM payroll_disbursement_items i
       WHERE i.tenant_id = ${tenantId}::uuid
         AND i.id IN (${uuidList(ids)})`),
  ))
    resolutions.set(String(row.id), {
      outcome: text(row.resolution_outcome),
      status: String(row.status),
      resolvedBy: text(row.resolved_by),
      resolvedBy2: text(row.resolved_by_2),
      lastProposeOperationId: null,
      steps: [],
    });
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT x::text AS item_id, a.step, a.actor, a.session_id,
             a.operation_id::text AS operation_id
        FROM payroll_payout_attestations a, unnest(a.item_ids) AS x
       WHERE a.tenant_id = ${tenantId}::uuid
         AND a.kind = 'resolve' AND a.step IN ('propose', 'approve')
         AND x IN (${uuidList(ids)})`),
  ))
    resolutions.get(String(row.item_id))?.steps.push({
      step: String(row.step),
      actor: String(row.actor),
      sessionId: String(row.session_id),
      operationId: String(row.operation_id),
    });
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT DISTINCT ON (x) x::text AS item_id, a.operation_id::text AS operation_id
        FROM payroll_payout_attestations a, unnest(a.item_ids) AS x
       WHERE a.tenant_id = ${tenantId}::uuid
         AND a.kind = 'resolve' AND a.step = 'propose'
         AND x IN (${uuidList(ids)})
       ORDER BY x, a.attested_at DESC, a.operation_id DESC`),
  )) {
    const facts = resolutions.get(String(row.item_id));
    if (facts) facts.lastProposeOperationId = String(row.operation_id);
  }
  return resolutions;
}

/**
 * Resolved items whose resolve attestations are gone (1038, finding 7). The
 * flags above start from the attestations that still exist, so deleting both
 * leaves nothing to check. The independent traces stay: the item row (status
 * `failed` / `not_sent`, an outcome, touched after the cutover) and the
 * append-only approval log (a resolve step on its batch after the cutover). An
 * item like that with no resolve attestation naming it is flagged
 * `attestation_count`, under the operation bound to the item itself (1052): the
 * propose step in the log whose grant carries the item's evidence key and
 * outcome (newest at or before the item's last update). With no such step the
 * fallback is the EARLIEST resolve propose of the batch since the cutover, so
 * resolving another item never moves the key; still flagged. A withdrawn proposal leaves no outcome on the
 * item, so it is not a candidate. Fail closed: a failed read fails the page.
 */
async function readLostResolutions(
  tx: Tx,
  tenantId: TenantId,
  grantsSince: Date,
): Promise<Flag[]> {
  const since = grantsSince.toISOString();
  return rowsOf(
    await tx.execute(sql`
      SELECT i.id::text AS item_id, l.operation_id::text AS operation_id
        FROM payroll_disbursement_items i
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            (SELECT g.operation_id
               FROM payroll_payout_approval_log g
               JOIN payroll_payout_grants gr
                 ON gr.tenant_id = g.tenant_id AND gr.id = g.grant_id
              WHERE g.tenant_id = ${tenantId}::uuid
                AND gr.tenant_id = ${tenantId}::uuid
                AND g.batch_id = i.batch_id
                AND gr.batch_id = i.batch_id
                AND g.kind = 'resolve' AND g.step = 'propose'
                AND gr.kind = 'resolve' AND gr.step = 'propose'
                AND gr.evidence_key = i.resolution_evidence_key
                AND gr.detail = i.resolution_outcome
                AND g.logged_at >= ${since}::timestamptz
                AND g.logged_at <= i.updated_at
              ORDER BY g.logged_at DESC, g.id DESC
              LIMIT 1),
            (SELECT g.operation_id
               FROM payroll_payout_approval_log g
              WHERE g.tenant_id = ${tenantId}::uuid
                AND g.batch_id = i.batch_id
                AND g.kind = 'resolve'
                AND g.logged_at >= ${since}::timestamptz
              ORDER BY (g.step = 'propose') DESC, g.logged_at ASC, g.id ASC
              LIMIT 1)) AS operation_id) l
       WHERE i.tenant_id = ${tenantId}::uuid
         AND l.operation_id IS NOT NULL
         AND i.status IN ('failed', 'not_sent')
         AND i.resolution_outcome IS NOT NULL
         AND i.updated_at >= ${since}::timestamptz
         AND NOT EXISTS (
           SELECT 1
             FROM payroll_payout_attestations a
            WHERE a.tenant_id = ${tenantId}::uuid
              AND a.kind = 'resolve'
              AND a.attested_at >= ${since}::timestamptz
              AND i.id = ANY(a.item_ids))`),
  ).map((row): Flag => ({
    kind: "resolve",
    operationId: String(row.operation_id),
    itemId: String(row.item_id),
    reason: "attestation_count",
  }));
}

async function readGrants(
  tx: Tx,
  tenantId: TenantId,
  attestations: readonly Attestation[],
): Promise<Map<string, GrantRow>> {
  const grants = new Map<string, GrantRow>();
  const grantIds = [
    ...new Set(
      attestations.flatMap((a) => (a.grantId === null ? [] : [a.grantId])),
    ),
  ];
  if (grantIds.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT g.id::text AS id, g.kind, g.step, g.actor, g.session_id,
               g.batch_id::text AS batch_id, g.item_set_hash, g.evidence_key,
               g.ref_id::text AS ref_id, g.detail, g.expires_at,
               g.consumed_at, g.consumed_txid
          FROM payroll_payout_grants g
         WHERE g.tenant_id = ${tenantId}::uuid
           AND g.id IN (${uuidList(grantIds)})`),
    ))
      grants.set(String(row.id), {
        kind: String(row.kind),
        step: String(row.step),
        actor: String(row.actor),
        sessionId: String(row.session_id),
        batchId: text(row.batch_id),
        itemSetHash: text(row.item_set_hash),
        evidenceKey: text(row.evidence_key),
        refId: text(row.ref_id),
        detail: text(row.detail),
        expiresAt: millis(row.expires_at),
        consumedAt: millis(row.consumed_at),
        consumedTxid:
          row.consumed_txid === null || row.consumed_txid === undefined
            ? null
            : Number(row.consumed_txid),
      });
  return grants;
}

/**
 * The withdraw steps of corrections and overpaid proposals, the main approval
 * of every batch (legend-xp8mc) and every resolve / bank_confirm step, at or
 * after the grant cutover. A withdrawn proposal is no operation (nothing was
 * corrected or recorded), and a batch approval, a resolution or a bank
 * confirmation is none of the operations above either, so they are read on
 * their own, whether or not their batch has any operation (990-D); the first
 * page only, the flags dedupe by operation across pages.
 */
async function loadWithdrawals(
  tx: Tx,
  tenantId: TenantId,
  grantsSince: Date,
): Promise<{
  attestations: Attestation[];
  grants: Map<string, GrantRow>;
  resolutions: Map<string, ResolutionFacts>;
  lostResolves: Flag[];
  flagged: Set<string>;
}> {
  const lostResolves = await readLostResolutions(tx, tenantId, grantsSince);
  const attestations = await readAttestations(
    tx,
    tenantId,
    sql`((a.step = 'withdraw' AND a.kind IN ('correction', 'overpaid'))
          OR a.kind IN ('batch_approve', 'resolve', 'bank_confirm'))
        AND a.attested_at >= ${grantsSince.toISOString()}::timestamptz`,
  );
  const grants = await readGrants(tx, tenantId, attestations);
  const resolutions = await readResolutions(tx, tenantId, attestations);
  const flagged = new Set<string>();
  const operationIds = [
    ...new Set([
      ...attestations.map((a) => a.operationId),
      ...lostResolves.map((flag) => flag.operationId),
    ]),
  ];
  if (operationIds.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT e.kind, e.operation_id::text AS operation_id, e.item_id::text AS item_id, e.reason
          FROM payroll_payout_recon_exceptions e
         WHERE e.tenant_id = ${tenantId}::uuid
           AND e.operation_id IN (${uuidList(operationIds)})`),
    ))
      flagged.add(
        flagKey(
          String(row.kind),
          String(row.operation_id),
          text(row.item_id),
          String(row.reason),
        ),
      );
  return { attestations, grants, resolutions, lostResolves, flagged };
}

/** A proof closure with the facts its check needs. */
type ClosureFacts = {
  id: string;
  evidenceKey: string;
  proposedBy: string;
  proposedSessionId: string | null;
  closedBy: string | null;
  closedSessionId: string | null;
  closed: boolean;
  /** Slips that carry a flag of this closure (see `loadClosures`). */
  itemIds: string[];
};

/**
 * The proof closures made since the trusted boundary, their attestations, the
 * grants of those and the slips each one holds (990-C); the first page only.
 *
 * A flag names an item (`recon_exceptions.item_id` is NOT NULL), and a closure
 * has none of its own, so a closure holds every item that used its proof key:
 * an item of an attestation, a resolution, a correction, an overpaid proposal
 * or a return claim with that key. A key nothing used holds every item of the
 * batch the proof was stuck on (the most restrictive choice, as a posting
 * source does). A closure with no batch and no item cannot be flagged.
 */
async function loadClosures(
  tx: Tx,
  tenantId: TenantId,
  since: Date,
): Promise<{
  closures: ClosureFacts[];
  attestations: Attestation[];
  grants: Map<string, GrantRow>;
  sessions: Map<string, SessionRow>;
  flagged: Set<string>;
}> {
  const sinceIso = since.toISOString();
  const rows = rowsOf(
    await tx.execute(sql`
      SELECT z.id::text AS id, z.evidence_key, z.proposed_by, z.proposed_session_id,
             z.closed_by, z.closed_session_id, z.closed_at,
             coalesce(
               (SELECT a.batch_id FROM payroll_payout_attestations a
                 WHERE a.tenant_id = z.tenant_id AND a.kind = 'closure'
                   AND a.operation_id = z.id
                 ORDER BY a.attested_at LIMIT 1),
               (SELECT s.batch_id FROM payroll_payout_proof_backfill_stuck s
                 WHERE s.tenant_id = z.tenant_id AND s.evidence_key = z.evidence_key
                 LIMIT 1))::text AS batch_id
        FROM payroll_payout_proof_closures z
       WHERE z.tenant_id = ${tenantId}::uuid
         AND z.proposed_at >= ${sinceIso}::timestamptz
       ORDER BY z.id`),
  );
  const none = {
    closures: [] as ClosureFacts[],
    attestations: [] as Attestation[],
    grants: new Map<string, GrantRow>(),
    sessions: new Map<string, SessionRow>(),
    flagged: new Set<string>(),
  };
  if (rows.length === 0) return none;
  const ids = rows.map((row) => String(row.id));
  const keys = [...new Set(rows.map((row) => String(row.evidence_key)))];
  const batches = [
    ...new Set(
      rows.flatMap((row) => (row.batch_id ? [String(row.batch_id)] : [])),
    ),
  ];

  const used = new Map<string, Set<string>>();
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT k.evidence_key, k.item_id FROM (
        SELECT a.evidence_key, x::text AS item_id
          FROM payroll_payout_attestations a, unnest(a.item_ids) AS x
         WHERE a.tenant_id = ${tenantId}::uuid AND a.kind <> 'closure'
           AND a.evidence_key IN (${inList(keys)})
        UNION
        SELECT i.resolution_evidence_key, i.id::text
          FROM payroll_disbursement_items i
         WHERE i.tenant_id = ${tenantId}::uuid
           AND i.resolution_evidence_key IN (${inList(keys)})
        UNION
        SELECT c.evidence_key, c.item_id::text
          FROM payroll_payout_failed_corrections c
         WHERE c.tenant_id = ${tenantId}::uuid AND c.evidence_key IN (${inList(keys)})
        UNION
        SELECT p.evidence_key, p.item_id::text
          FROM payroll_payout_overpaid_proposals p
         WHERE p.tenant_id = ${tenantId}::uuid AND p.evidence_key IN (${inList(keys)})
        UNION
        SELECT c.evidence_key, i.id::text
          FROM payroll_payout_return_claims c
          JOIN payroll_disbursement_items i
            ON i.tenant_id = c.tenant_id AND i.return_claim_id = c.id
         WHERE c.tenant_id = ${tenantId}::uuid AND c.evidence_key IN (${inList(keys)})
      ) k`),
  )) {
    const set = used.get(String(row.evidence_key)) ?? new Set<string>();
    set.add(String(row.item_id));
    used.set(String(row.evidence_key), set);
  }
  const ofBatch = new Map<string, string[]>();
  if (batches.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT i.batch_id::text AS batch_id, i.id::text AS id
          FROM payroll_disbursement_items i
         WHERE i.tenant_id = ${tenantId}::uuid
           AND i.batch_id IN (${uuidList(batches)})`),
    )) {
      const list = ofBatch.get(String(row.batch_id)) ?? [];
      list.push(String(row.id));
      ofBatch.set(String(row.batch_id), list);
    }

  const closures = rows.map((row): ClosureFacts => {
    const key = String(row.evidence_key);
    const byKey = [...(used.get(key) ?? [])];
    return {
      id: String(row.id),
      evidenceKey: key,
      proposedBy: String(row.proposed_by),
      proposedSessionId: text(row.proposed_session_id),
      closedBy: text(row.closed_by),
      closedSessionId: text(row.closed_session_id),
      closed: row.closed_at !== null && row.closed_at !== undefined,
      itemIds:
        byKey.length > 0
          ? byKey
          : row.batch_id
            ? (ofBatch.get(String(row.batch_id)) ?? [])
            : [],
    };
  });

  // Every step of these closures, whenever it was made: a missing step is the
  // difference. The grant check below skips steps before the grant cutover.
  const attestations = await readAttestations(
    tx,
    tenantId,
    sql`a.kind = 'closure' AND a.operation_id IN (${uuidList(ids)})`,
  );
  const grants = await readGrants(tx, tenantId, attestations);
  const sessions = new Map<string, SessionRow>();
  const sessionIds = [...new Set(attestations.map((a) => a.sessionId))];
  if (sessionIds.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT s.id, s.user_id, s.created_at, s.mfa_verified_at
          FROM session s WHERE s.id IN (${inList(sessionIds)})`),
    ))
      sessions.set(String(row.id), {
        userId: String(row.user_id),
        createdAt: millis(row.created_at),
        mfaVerifiedAt: millis(row.mfa_verified_at),
      });
  const flagged = new Set<string>();
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT e.kind, e.operation_id::text AS operation_id, e.item_id::text AS item_id, e.reason
        FROM payroll_payout_recon_exceptions e
       WHERE e.tenant_id = ${tenantId}::uuid
         AND e.kind = 'closure' AND e.operation_id IN (${uuidList(ids)})`),
  ))
    flagged.add(
      flagKey(
        String(row.kind),
        String(row.operation_id),
        text(row.item_id),
        String(row.reason),
      ),
    );
  return { closures, attestations, grants, sessions, flagged };
}

/**
 * A closure needs a propose step and, once closed, an approve step, each by the
 * person the closure names, from two different sessions of two different
 * people (990-C). The session columns of the closure row are never filled by
 * the trusted functions, so they are compared only when they hold a value.
 * Pure, no I/O.
 */
function evaluateClosures(
  closures: readonly ClosureFacts[],
  attestations: readonly Attestation[],
  sessions: ReadonlyMap<string, SessionRow>,
  grants: ReadonlyMap<string, GrantRow>,
): Flag[] {
  const flags: Flag[] = [];
  // The session columns of the closure row stay empty, so the session of a
  // step is also compared with the one its grant was issued to.
  const grantSessionDiffers = (a: Attestation | undefined) => {
    const grant = a?.grantId ? grants.get(a.grantId) : undefined;
    return (
      grant !== undefined && a !== undefined && grant.sessionId !== a.sessionId
    );
  };
  for (const closure of closures) {
    const reasons = new Set<PayoutReconReason>();
    const steps = attestations.filter((a) => a.operationId === closure.id);
    const propose = steps.find((a) => a.step === "propose");
    const approve = steps.find((a) => a.step === "approve");
    if (!propose || (closure.closed && !approve))
      reasons.add("attestation_count");
    if (closure.closedBy !== null && closure.closedBy === closure.proposedBy)
      reasons.add("attestation_same_person");
    if (propose && approve) {
      if (propose.actor === approve.actor)
        reasons.add("attestation_same_person");
      if (propose.sessionId === approve.sessionId)
        reasons.add("attestation_same_session");
    }
    if (
      (propose && propose.actor !== closure.proposedBy) ||
      (approve &&
        closure.closedBy !== null &&
        approve.actor !== closure.closedBy)
    )
      reasons.add("closure_actor_mismatch");
    if (
      (propose &&
        closure.proposedSessionId !== null &&
        propose.sessionId !== closure.proposedSessionId) ||
      (approve &&
        closure.closedSessionId !== null &&
        approve.sessionId !== closure.closedSessionId)
    )
      reasons.add("closure_session_mismatch");
    if (grantSessionDiffers(propose) || grantSessionDiffers(approve))
      reasons.add("closure_session_mismatch");
    for (const a of steps) {
      if (sessionMismatch(a, sessions)) reasons.add("session_mismatch");
      if (mfaStale(a)) reasons.add("mfa_stale");
    }
    for (const itemId of closure.itemIds)
      for (const reason of reasons)
        flags.push({
          kind: "closure",
          operationId: closure.id,
          itemId,
          reason,
        });
  }
  return flags;
}

async function loadFacts(
  tx: Tx,
  tenantId: TenantId,
  operations: readonly Operation[],
  since: Date,
  grantsSince: Date | null,
): Promise<Facts> {
  const batchIds = [...new Set(operations.map((op) => op.batchId))];
  const itemIds = [
    ...new Set(
      operations.flatMap((op) => [...op.itemIds, ...op.terminalItemIds]),
    ),
  ];
  const keys = [
    ...new Set(
      operations.flatMap((op) =>
        op.evidenceKey === null ? [] : [op.evidenceKey],
      ),
    ),
  ];
  const sinceIso = since.toISOString();

  const attestations = await readAttestations(
    tx,
    tenantId,
    sql`a.batch_id IN (${uuidList(batchIds)})`,
  );

  const operationIds = [
    ...new Set([
      ...operations.map((op) => op.operationId),
      ...attestations.map((a) => a.operationId),
    ]),
  ];

  const grants = await readGrants(tx, tenantId, attestations);
  const resolutions = await readResolutions(tx, tenantId, attestations);

  const sessions = new Map<string, SessionRow>();
  const sessionIds = [...new Set(attestations.map((a) => a.sessionId))];
  if (sessionIds.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT s.id, s.user_id, s.created_at, s.mfa_verified_at
          FROM session s WHERE s.id IN (${inList(sessionIds)})`),
    ))
      sessions.set(String(row.id), {
        userId: String(row.user_id),
        createdAt: millis(row.created_at),
        mfaVerifiedAt: millis(row.mfa_verified_at),
      });

  const bindings = rowsOf(
    await tx.execute(sql`
      SELECT b.kind, b.batch_id::text AS batch_id, b.item_set_hash, b.evidence_key,
             b.content_sha256, b.stored_sha256, b.legacy_duplicate,
             b.created_by
        FROM payroll_payout_proof_bindings b
       WHERE b.tenant_id = ${tenantId}::uuid
         AND b.batch_id IN (${uuidList(batchIds)})`),
  ).map((row): Binding => ({
    kind: String(row.kind),
    batchId: String(row.batch_id),
    itemSetHash: String(row.item_set_hash),
    evidenceKey: String(row.evidence_key),
    contentSha256: String(row.content_sha256),
    storedSha256: String(row.stored_sha256),
    legacyDuplicate: row.legacy_duplicate === true,
    createdBy: String(row.created_by),
  }));
  // Only a yes or no is available for a hash (the global contest list).
  const contested = new Map<string, boolean>();
  const hashesHeld = new Map<string, boolean>();
  for (const binding of bindings) {
    if (!keys.includes(binding.evidenceKey)) continue;
    const answer = rowsOf(
      await tx.execute(
        sql`SELECT app.payout_proof_contested(ARRAY[${binding.contentSha256}, ${binding.storedSha256}]::varchar[]) AS contested`,
      ),
    )[0];
    contested.set(binding.evidenceKey, answer?.contested === true);
    const held = rowsOf(
      await tx.execute(
        sql`SELECT app.payout_proof_hashes_held(${binding.evidenceKey}) AS held`,
      ),
    )[0];
    hashesHeld.set(binding.evidenceKey, held?.held === true);
  }

  const records = new Map<string, FileRecord>();
  if (keys.length > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
        SELECT f.evidence_key, f.content_sha256, f.stored_sha256,
               f.batch_id::text AS batch_id
          FROM payroll_payout_evidence_files f
         WHERE f.tenant_id = ${tenantId}::uuid AND f.evidence_key IN (${inList(keys)})`),
    ))
      records.set(String(row.evidence_key), {
        content: String(row.content_sha256),
        stored: text(row.stored_sha256),
        batchId: String(row.batch_id),
      });

  const actions = Object.values(AUDIT_ACTIONS).flat();
  const objectIds = [...new Set([...batchIds, ...itemIds])];
  const audits = rowsOf(
    await tx.execute(sql`
      SELECT al.event->>'action' AS action, al.event->>'objectId' AS object_id,
             al.event #>> '{maskedChanges,after,evidenceKey}' AS evidence_key,
             al.event #>> '{maskedChanges,after,postingId}' AS posting_id,
             al.event #>> '{maskedChanges,after,by}' AS by_user
        FROM audit_logs al
       WHERE al.tenant_id = ${tenantId}::uuid
         AND al.created_at >= ${sinceIso}::timestamptz
         AND al.event->>'action' IN (${inList(actions)})
         AND al.event->>'objectId' IN (${inList(objectIds)})`),
  ).map((row): AuditRow => ({
    action: String(row.action),
    objectId: text(row.object_id),
    evidenceKey: text(row.evidence_key),
    postingId: text(row.posting_id),
    by: text(row.by_user),
  }));

  const items = new Map<string, ItemFacts>();
  const groups = new Map<string, ItemFacts[]>();
  const toFacts = (row: {
    id: string;
    payslipId: string;
    glPostingId: string | null;
    amountEncrypted: Buffer;
    feeIdrEncrypted: Buffer;
    piiKeyVersion: number;
  }): ItemFacts => {
    let net: number | null;
    try {
      net = Number(
        openItemAmount({
          id: row.id,
          tenantId,
          amountEncrypted: row.amountEncrypted,
          piiKeyVersion: row.piiKeyVersion,
        }),
      );
      if (!Number.isSafeInteger(net)) net = null;
    } catch {
      net = null;
    }
    let fee: number | null;
    try {
      fee = Number(
        openItemFee({
          id: row.id,
          tenantId,
          feeIdrEncrypted: row.feeIdrEncrypted,
          piiKeyVersion: row.piiKeyVersion,
        }),
      );
      if (!Number.isSafeInteger(fee) || fee < 0) fee = null;
    } catch {
      fee = null;
    }
    return {
      id: row.id,
      payslipId: row.payslipId,
      glPostingId: row.glPostingId,
      net,
      fee,
    };
  };
  const itemColumns = {
    id: payrollDisbursementItems.id,
    payslipId: payrollDisbursementItems.payslipId,
    glPostingId: payrollDisbursementItems.glPostingId,
    amountEncrypted: payrollDisbursementItems.amountEncrypted,
    feeIdrEncrypted: payrollDisbursementItems.feeIdrEncrypted,
    piiKeyVersion: payrollDisbursementItems.piiKeyVersion,
  };
  if (itemIds.length > 0)
    for (const row of await tx
      .select(itemColumns)
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          inArray(payrollDisbursementItems.id, itemIds),
        ),
      ))
      items.set(row.id, toFacts(row));

  const postingIds = [
    ...new Set(
      [...items.values()].flatMap((item) =>
        item.glPostingId === null ? [] : [item.glPostingId],
      ),
    ),
  ];
  const postings = new Map<
    string,
    { kind: string; journalKey: string; feeIdr: number | null }
  >();
  if (postingIds.length > 0) {
    for (const row of await tx
      .select({
        id: payrollPayoutGlPostings.id,
        kind: payrollPayoutGlPostings.kind,
        journalKey: payrollPayoutGlPostings.journalKey,
        feeIdr: payrollPayoutGlPostings.feeIdr,
      })
      .from(payrollPayoutGlPostings)
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          inArray(payrollPayoutGlPostings.id, postingIds),
        ),
      ))
      postings.set(row.id, {
        kind: row.kind,
        journalKey: row.journalKey,
        feeIdr: row.feeIdr,
      });
    for (const row of await tx
      .select(itemColumns)
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, tenantId),
          inArray(payrollDisbursementItems.glPostingId, postingIds),
        ),
      )) {
      const facts = toFacts(row);
      const group = groups.get(row.glPostingId!) ?? [];
      group.push(facts);
      groups.set(row.glPostingId!, group);
    }
  }

  const runOfBatch = new Map<string, string>();
  for (const row of await tx
    .select({
      id: payrollDisbursementBatches.id,
      runId: payrollDisbursementBatches.payrollRunId,
    })
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenantId),
        inArray(payrollDisbursementBatches.id, batchIds),
      ),
    ))
    runOfBatch.set(row.id, row.runId);

  const sourceItems = new Map<string, string[]>();
  const sourceOps = operations.filter((op) => op.kind === "posting_source");
  if (sourceOps.length > 0) {
    const paid = rowsOf(
      await tx.execute(sql`
        SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.gl_posting_id::text AS posting_id
          FROM payroll_disbursement_items i
         WHERE i.tenant_id = ${tenantId}::uuid
           AND i.batch_id IN (${uuidList(sourceOps.map((op) => op.batchId))})
           AND i.status IN ('succeeded', 'returned')`),
    );
    for (const op of sourceOps) {
      const linked = paid
        .filter((row) => text(row.posting_id) === op.operationId)
        .map((row) => String(row.id));
      sourceItems.set(
        op.operationId,
        linked.length > 0
          ? linked
          : paid
              .filter((row) => String(row.batch_id) === op.batchId)
              .map((row) => String(row.id)),
      );
    }
  }

  const journalKeys = new Set<string>();
  for (const run of runOfBatch.values())
    journalKeys.add(payrollGlKeys.locked(run));
  for (const op of operations)
    for (const id of op.terminalItemIds) {
      if (op.kind === "overpaid") {
        journalKeys.add(overpaidJournalKey(id));
        journalKeys.add(overpaidFeeJournalKey(id));
      }
      if (op.kind === "return") journalKeys.add(payoutGlKeys.return(id));
    }
  for (const posting of postings.values()) journalKeys.add(posting.journalKey);
  const journals = new Map<string, Journal>();
  if (journalKeys.size > 0)
    for (const row of rowsOf(
      await tx.execute(sql`
      SELECT je.idempotency_key, je.id::text AS id,
             coalesce((SELECT sum(jl.debit_idr) FROM journal_lines jl
                        WHERE jl.tenant_id = je.tenant_id AND jl.entry_id = je.id), 0)::text AS debit,
             EXISTS (SELECT 1 FROM journal_entries r
                      WHERE r.tenant_id = je.tenant_id AND r.reversal_of = je.id) AS reversed
        FROM journal_entries je
       WHERE je.tenant_id = ${tenantId}::uuid
         AND je.idempotency_key IN (${inList([...journalKeys])})`),
    ))
      journals.set(String(row.idempotency_key), {
        id: String(row.id),
        debit: BigInt(String(row.debit)),
        reversed: row.reversed === true,
      });

  const flagged = new Set<string>();
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT e.kind, e.operation_id::text AS operation_id, e.item_id::text AS item_id, e.reason
        FROM payroll_payout_recon_exceptions e
       WHERE e.tenant_id = ${tenantId}::uuid
         AND e.operation_id IN (${uuidList(operationIds)})`),
  ))
    flagged.add(
      flagKey(
        String(row.kind),
        String(row.operation_id),
        text(row.item_id),
        String(row.reason),
      ),
    );

  return {
    attestations,
    grants,
    grantsSince: grantsSince?.getTime() ?? null,
    sessions,
    bindings,
    contested,
    hashesHeld,
    records,
    audits,
    journals,
    items,
    postings,
    resolutions,
    groups,
    runOfBatch,
    sourceItems,
    flagged,
    accountingOn: await accountingEnabled(tx, tenantId),
  };
}

type FileState = "ok" | "missing" | "mismatch" | "error";

/**
 * A signed-out user has no live session row: that is not a mismatch. Compare
 * with the attestation snapshot only when a row exists.
 */
function sessionMismatch(
  a: Attestation,
  sessions: ReadonlyMap<string, SessionRow>,
): boolean {
  const s = sessions.get(a.sessionId);
  if (!s) return false;
  return (
    s.userId !== a.actor ||
    s.createdAt !== a.sessionCreatedAt ||
    s.mfaVerifiedAt === null ||
    a.mfaVerifiedAt === null ||
    s.mfaVerifiedAt < a.mfaVerifiedAt
  );
}

const mfaStale = (a: Attestation): boolean =>
  a.mfaVerifiedAt === null ||
  a.attestedAt === null ||
  a.mfaVerifiedAt > a.attestedAt ||
  a.attestedAt - a.mfaVerifiedAt > MFA_MAX_AGE_MS + MFA_AGE_TOLERANCE_MS;

type Flag = {
  kind: PayoutReconFlagKind;
  operationId: string;
  itemId: string;
  reason: PayoutReconReason;
};

/** The reasons of one operation; pure, no I/O. */
function evaluate(
  op: Operation,
  facts: Facts,
  fileOf: ReadonlyMap<string, FileState>, // by operation id
): Flag[] {
  if (op.missing)
    return op.terminalItemIds.map((itemId) => ({
      kind: op.kind,
      operationId: op.operationId,
      itemId,
      reason: "operation_missing",
    }));
  const flags: Flag[] = [];
  const add = (itemId: string | null, reason: PayoutReconReason) => {
    if (itemId === null) {
      for (const slip of facts.sourceItems.get(op.operationId) ?? [])
        flags.push({
          kind: op.kind,
          operationId: op.operationId,
          itemId: slip,
          reason,
        });
      return;
    }
    flags.push({ kind: op.kind, operationId: op.operationId, itemId, reason });
  };
  // A posting source has one attestation; its differences are flagged on every
  // item it holds (see `sourceItems`), so each of those slips is held.
  const held =
    op.kind === "posting_source"
      ? (facts.sourceItems.get(op.operationId) ?? [])
      : op.terminalItemIds;
  const subjects: (string | null)[] =
    op.kind === "posting_source" ? [null] : op.terminalItemIds;
  const addAll = (reason: PayoutReconReason) => {
    for (const subject of held) add(subject, reason);
  };
  const required = op.kind === "posting_source" ? 1 : 2;

  // Attestations, sessions and MFA, per item (per posting for a source).
  const opActors = new Set<string>();
  for (const subject of subjects) {
    const atts = facts.attestations.filter(
      (a) =>
        a.kind === op.kind &&
        // A withdrawal is not a step of the operation (grants check it).
        a.step !== "withdraw" &&
        a.batchId === op.batchId &&
        (op.kind === "posting_source"
          ? a.operationId === op.operationId
          : a.evidenceKey === op.evidenceKey &&
            subject !== null &&
            a.itemIds.includes(subject)),
    );
    for (const a of atts) opActors.add(a.actor);
    if (atts.length < required) add(subject, "attestation_count");
    if (
      new Set(atts.map((a) => a.actor)).size < Math.min(required, atts.length)
    )
      add(subject, "attestation_same_person");
    if (
      new Set(atts.map((a) => a.sessionId)).size <
      Math.min(required, atts.length)
    )
      add(subject, "attestation_same_session");
    if (atts.some((a) => sessionMismatch(a, facts.sessions)))
      add(subject, "session_mismatch");
    if (atts.some(mfaStale)) add(subject, "mfa_stale");
  }

  // Audit rows: the same people, at least `required` of them.
  const scope = new Set([op.batchId, ...op.terminalItemIds]);
  const auditActors = new Set(
    facts.audits
      .filter(
        (row) =>
          (AUDIT_ACTIONS[op.kind] as readonly string[]).includes(row.action) &&
          row.objectId !== null &&
          scope.has(row.objectId) &&
          (op.kind === "posting_source"
            ? row.postingId === op.operationId
            : row.evidenceKey === op.evidenceKey) &&
          row.by !== null,
      )
      .map((row) => row.by!),
  );
  if (
    auditActors.size < required ||
    [...opActors].some((actor) => !auditActors.has(actor))
  )
    addAll("audit_mismatch");

  if (op.kind !== "posting_source" && op.evidenceKey !== null) {
    // Exactly one binding of this operation, over this proof, not contested.
    const setHash = itemSetHashOf(op.itemIds);
    const own = facts.bindings.find((b) => b.evidenceKey === op.evidenceKey);
    const record = facts.records.get(op.evidenceKey);
    if (!own) addAll("binding_missing");
    else {
      if (
        own.kind !== op.kind ||
        own.batchId !== op.batchId ||
        own.itemSetHash !== setHash ||
        own.legacyDuplicate ||
        // The proof file must have been uploaded for this very batch.
        (record !== undefined && record.batchId !== op.batchId) ||
        facts.hashesHeld.get(op.evidenceKey) !== true ||
        (record !== undefined &&
          (own.contentSha256 !== record.content ||
            (record.stored !== null && own.storedSha256 !== record.stored)))
      )
        addAll("binding_mismatch");
      if (facts.contested.get(op.evidenceKey) !== false)
        addAll("binding_contested");
    }
    // A binding of a proposal proof that was replaced is permanent on purpose
    // but is not a second completed operation. It is told apart by the proposal
    // audit row of the same person for that key while no attestation holds the
    // key any more (the replacement overwrites the step-one attestation). A
    // binding with no such trace stays a duplicate (the most restrictive choice).
    const replaced = (b: Binding) =>
      (op.kind === "correction" || op.kind === "overpaid") &&
      !facts.attestations.some((a) => a.evidenceKey === b.evidenceKey) &&
      facts.audits.some(
        (row) =>
          row.action === AUDIT_ACTIONS[op.kind][0] &&
          row.evidenceKey === b.evidenceKey &&
          row.by === b.createdBy &&
          row.objectId !== null &&
          (row.objectId === op.batchId || op.itemIds.includes(row.objectId)),
      );
    // A binding whose proof was withdrawn (a withdraw attestation and no step
    // that completed it: neither propose nor withdraw) is history, not a second
    // completed operation. The binding stays and the proof is never reusable.
    const withdrawn = (b: Binding) => {
      const own = facts.attestations.filter(
        (a) => a.kind === op.kind && a.evidenceKey === b.evidenceKey,
      );
      return (
        own.some((a) => a.step === "withdraw") &&
        !own.some((a) => a.step !== "propose" && a.step !== "withdraw")
      );
    };
    if (
      facts.bindings.some(
        (b) =>
          b.evidenceKey !== op.evidenceKey &&
          b.kind === op.kind &&
          b.batchId === op.batchId &&
          b.itemSetHash === setHash &&
          !replaced(b) &&
          !withdrawn(b),
      )
    )
      addAll("binding_duplicate");
    if (!record) addAll("evidence_record_missing");
    const file = fileOf.get(op.operationId);
    if (file === "missing") addAll("evidence_missing");
    if (file === "mismatch") addAll("evidence_hash_mismatch");
  }

  // Journals against the decrypted nets.
  if (op.kind !== "posting_source") {
    const lockExists = (batchId: string) => {
      const run = facts.runOfBatch.get(batchId);
      return run !== undefined && facts.journals.has(payrollGlKeys.locked(run));
    };
    const checkJournal = (
      subject: string,
      journal: Journal | undefined,
      net: number | null,
      expected: boolean,
    ) => {
      if (!journal) {
        if (expected) add(subject, "journal_missing");
        return;
      }
      if (journal.reversed) add(subject, "journal_reversed");
      if (net === null) add(subject, "net_unreadable");
      else if (journal.debit !== BigInt(net)) add(subject, "net_mismatch");
    };
    const settledGroups = new Set<string>();
    for (const id of op.terminalItemIds) {
      const item = facts.items.get(id);
      if (!item) {
        add(id, "posting_missing");
        continue;
      }
      if (item.glPostingId === null) {
        add(id, "posting_missing");
        continue;
      }
      const posting = facts.postings.get(item.glPostingId);
      if (!posting) {
        add(id, "posting_missing");
        continue;
      }
      if (op.kind === "overpaid") {
        checkJournal(
          id,
          facts.journals.get(overpaidJournalKey(id)),
          item.net,
          lockExists(op.batchId),
        );
        // The fee journal is owed exactly when the posting carries a fee (the
        // service only fills `fee_idr` when it journals it, docs/briefs/990/
        // i3-note.md). The posted fee must equal the sealed fee of the item
        // (unreadable or absent while the posting has a fee: fail closed) and
        // the fee journal debit must equal the posted fee (990-B). A posted
        // fee of 0 against a sealed fee above 0 is legit only when nothing was
        // journaled (neither the overpaid journal nor the fee journal exists)
        // and accounting is off, exactly the overpaid service's rule; a NULL
        // posted fee fails closed.
        if (posting.feeIdr === null) add(id, "fee_sealed_mismatch");
        else {
          const unjournaledZero =
            posting.feeIdr === 0 &&
            item.fee !== null &&
            item.fee > 0 &&
            !facts.journals.has(overpaidJournalKey(id)) &&
            !facts.journals.has(overpaidFeeJournalKey(id)) &&
            !facts.accountingOn;
          if (
            !unjournaledZero &&
            (item.fee === null
              ? posting.feeIdr > 0
              : item.fee !== posting.feeIdr)
          )
            add(id, "fee_sealed_mismatch");
          if (posting.feeIdr > 0) {
            const fee = facts.journals.get(overpaidFeeJournalKey(id));
            if (!fee) add(id, "journal_missing");
            else {
              if (fee.reversed) add(id, "journal_reversed");
              if (fee.debit !== BigInt(posting.feeIdr))
                add(id, "fee_journal_amount");
            }
          }
        }
      } else if (posting.kind === "settle") {
        if (op.kind === "return")
          checkJournal(
            id,
            facts.journals.get(payoutGlKeys.return(id)),
            item.net,
            true,
          );
        else if (!settledGroups.has(item.glPostingId)) {
          // A correction settles its group: the debit is the sum of the group.
          settledGroups.add(item.glPostingId);
          const group = facts.groups.get(item.glPostingId) ?? [item];
          const nets = group.map((member) => member.net);
          checkJournal(
            id,
            facts.journals.get(posting.journalKey),
            nets.some((net) => net === null)
              ? null
              : nets.reduce<number>((sum, net) => sum + net!, 0),
            true,
          );
        }
      }
    }
  }
  return flags;
}

/** Steps whose grant `ref_id` is the operation the attestation names. */
const GRANT_REF_IS_OPERATION: ReadonlySet<string> = new Set([
  "correction:approve",
  "correction:withdraw",
  "return:confirm",
  "closure:approve",
  "posting_source:record",
]);
/** Steps whose grant carries no `ref_id` (`overpaid:record` binds the posting). */
const GRANT_REF_IS_NULL: ReadonlySet<string> = new Set([
  "correction:propose",
  "overpaid:propose",
  "overpaid:withdraw",
  "return:propose",
  "closure:propose",
  "resolve:propose",
  "resolve:approve",
  "bank_confirm:record",
  "batch_approve:approve",
]);
/** Kinds whose grant carries no `detail`; resolve and bank_confirm have one. */
const GRANT_DETAIL_IS_NULL: ReadonlySet<string> = new Set([
  "correction",
  "overpaid",
  "return",
  "closure",
  "posting_source",
  "batch_approve",
]);

/**
 * What the grant was bound to against what the step did (990-D). The consume
 * function matches the item set, ref and detail it is given, so a difference
 * means the grant row or the attestation was changed after the step. The item
 * set of a batch approval and of a step without items is NULL. The outcome of
 * a resolution is the one stored on its items, compared only where it still
 * speaks for the step: a propose step is compared for the last proposal made
 * for the item and while its proposer still holds it (an older proposal was
 * withdrawn and made again, maybe with another outcome); an approve step only
 * while the item sits in the outcome it moved to (`failed` or `not_sent`).
 */
function grantBindingMismatch(
  a: Attestation,
  grant: GrantRow,
  resolutions: ReadonlyMap<string, ResolutionFacts>,
): boolean {
  const itemSet =
    a.kind === "batch_approve" || a.itemIds.length === 0
      ? null
      : itemSetHashOf(a.itemIds);
  if (grant.itemSetHash !== itemSet) return true;
  if (a.kind === "resolve") {
    if (grant.detail === null) return true;
    for (const id of a.itemIds) {
      const item = resolutions.get(id);
      if (!item || item.outcome === null) continue;
      const comparable =
        a.step === "propose"
          ? item.lastProposeOperationId === a.operationId &&
            item.resolvedBy === a.actor
          : a.step === "approve" &&
            (item.status === "failed" || item.status === "not_sent");
      if (comparable && item.outcome !== grant.detail) return true;
    }
  } else if (a.kind === "bank_confirm") {
    if (grant.detail !== "succeeded") return true;
  } else if (GRANT_DETAIL_IS_NULL.has(a.kind) && grant.detail !== null)
    return true;
  const step = `${a.kind}:${a.step}`;
  if (GRANT_REF_IS_OPERATION.has(step)) return grant.refId !== a.operationId;
  if (GRANT_REF_IS_NULL.has(step)) return grant.refId !== null;
  return false;
}

/**
 * A resolution that moved an item to `failed` / `not_sent` needs both steps on
 * file (990-D): a propose attestation by the first resolver and an approve
 * attestation by the second one, two people from two sessions. The grant check
 * only compares the attestations that exist, so one deleted step (or a second
 * step forged with the first person's session) is judged here. Items that are
 * not resolved yet, or moved on, are skipped. Pure, no I/O.
 */
function evaluateResolutions(
  attestations: readonly Attestation[],
  resolutions: ReadonlyMap<string, ResolutionFacts>,
  grantsSince: number | null,
): Flag[] {
  if (grantsSince === null) return [];
  const flags: Flag[] = [];
  const done = new Set<string>();
  const ordered = attestations
    .filter(
      (a) =>
        a.kind === "resolve" &&
        a.attestedAt !== null &&
        a.attestedAt >= grantsSince,
    )
    .sort(
      (x, y) =>
        (x.attestedAt ?? 0) - (y.attestedAt ?? 0) ||
        x.operationId.localeCompare(y.operationId),
    );
  for (const a of ordered)
    for (const itemId of a.itemIds) {
      const item = resolutions.get(itemId);
      if (
        done.has(itemId) ||
        !item ||
        (item.status !== "failed" && item.status !== "not_sent")
      )
        continue;
      done.add(itemId);
      // Only the standing proposal counts: a withdrawn earlier propose by
      // another person or session must not satisfy the two-person check.
      const first = item.steps.filter(
        (s) =>
          s.step === "propose" &&
          s.actor === item.resolvedBy &&
          s.operationId === item.lastProposeOperationId,
      );
      const second = item.steps.filter(
        (s) =>
          s.step === "approve" &&
          (item.resolvedBy2 === null || s.actor === item.resolvedBy2),
      );
      const reasons = new Set<PayoutReconReason>();
      if (first.length === 0 || second.length === 0)
        reasons.add("attestation_count");
      else {
        if (!first.some((f) => second.some((s) => s.actor !== f.actor)))
          reasons.add("attestation_same_person");
        if (!first.some((f) => second.some((s) => s.sessionId !== f.sessionId)))
          reasons.add("attestation_same_session");
      }
      for (const reason of reasons)
        flags.push({
          kind: "resolve",
          operationId: a.operationId,
          itemId,
          reason,
        });
    }
  return flags;
}

/**
 * Every attestation made at or after `app.payout_grants_since()` needs its
 * one-time grant (0419/0420): no grant, or a grant that was not spent by that
 * very step, holds the slips of the attestation. Pure, no I/O. An attestation
 * before the cutover is skipped like `trusted_since`.
 */
function evaluateGrants(
  facts: Pick<
    Facts,
    "grantsSince" | "attestations" | "grants" | "sourceItems" | "resolutions"
  >,
): Flag[] {
  if (facts.grantsSince === null) return [];
  const flags: Flag[] = [];
  for (const a of facts.attestations) {
    if (a.attestedAt === null || a.attestedAt < facts.grantsSince) continue;
    const grant = a.grantId === null ? undefined : facts.grants.get(a.grantId);
    const reason: PayoutReconReason | null =
      grant === undefined
        ? "grant_missing"
        : grant.consumedAt === null ||
            grant.expiresAt === null ||
            grant.consumedAt > grant.expiresAt ||
            grant.actor !== a.actor ||
            grant.sessionId !== a.sessionId ||
            grant.kind !== a.kind ||
            grant.step !== a.step ||
            grant.batchId !== a.batchId ||
            // A bank confirmation's proof key is not part of its grant (the
            // grant is bound to actor, batch and items), so it is not compared.
            (a.kind !== "bank_confirm" &&
              grant.evidenceKey !== a.evidenceKey) ||
            grant.consumedTxid !== a.txid ||
            grantBindingMismatch(a, grant, facts.resolutions)
          ? "grant_mismatch"
          : null;
    if (reason === null) continue;
    // A posting source names no item itself: the slips it holds.
    const items =
      a.itemIds.length > 0
        ? a.itemIds
        : (facts.sourceItems.get(a.operationId) ?? []);
    for (const itemId of items)
      flags.push({
        kind: a.kind as PayoutReconFlagKind,
        operationId: a.operationId,
        itemId,
        reason,
      });
  }
  return flags;
}

/**
 * Records a successful read of the proof file of an operation (1057, legend-qh11l,
 * migration 0674). An 'ok' observation can release a slip again after a read
 * error, so only the role `legend_payout_recon` may record it
 * (`app.payout_recon_evidence_observe_ok`); `app.payout_recon_evidence_observe`
 * refuses 'ok'. The role is taken with `SET LOCAL ROLE` for this one call and the
 * previous role is restored right after; a failure aborts the transaction, which
 * ends the role with it.
 */
export async function recordReadOk(
  tx: Tx,
  tenantId: string,
  operationId: string,
): Promise<void> {
  const previous = text(
    rowsOf(
      await tx.execute(sql`SELECT pg_catalog.quote_ident(current_user) AS r`),
    )[0]?.r,
  );
  if (previous === null)
    throw new Error("Cannot read the current database role");
  await tx.execute(sql`SET LOCAL ROLE legend_payout_recon`);
  await tx.execute(
    sql`SELECT app.payout_recon_evidence_observe_ok(${tenantId}::uuid, ${operationId}::uuid)`,
  );
  await tx.execute(sql.raw(`SET LOCAL ROLE ${previous}`));
}

export type PayoutReconOptions = {
  /** Object storage for the proof files; without it the file check is skipped. */
  storage: ObjectStorage | null | undefined;
  now?: Date;
  /** Sort key of the last operation of the previous page. */
  after?: string | null;
  limit?: number;
  /** Test override of `app.payout_trusted_since()`. */
  since?: Date;
};

/** Known flags raised again per transaction (each call keeps an advisory lock). */
export const PAYOUT_RECON_RERAISE_CHUNK = 100;

/**
 * Raises known flags again, `chunkSize` per `withTenant`. A failed chunk is
 * logged (no personal data) and counted; the other chunks still run.
 */
export async function reraiseKnownFlags(
  context: ScopedTenantContext,
  flags: readonly Flag[],
  chunkSize: number = PAYOUT_RECON_RERAISE_CHUNK,
): Promise<{ reraised: number; failed: number }> {
  const tenantId = context.tenant.tenantId;
  let reraised = 0;
  let failed = 0;
  for (let at = 0; at < flags.length; at += chunkSize) {
    const chunk = flags.slice(at, at + chunkSize);
    try {
      await withTenant(db, context, async (tx) => {
        for (const flag of chunk)
          await tx.execute(
            sql`SELECT app.payout_recon_flag(${tenantId}::uuid, ${flag.kind}, ${flag.operationId}::uuid, ${flag.itemId}::uuid, ${flag.reason})`,
          );
      });
      reraised += chunk.length;
    } catch (error) {
      failed += chunk.length;
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "unknown",
          chunkSize: chunk.length,
        },
        "payout recon: raising known flags again failed",
      );
    }
  }
  return { reraised, failed };
}

/**
 * One page of operations of one tenant (tenant-wide worker context). Reads in
 * one transaction, reads the proof files outside it, then writes the new flags
 * in a second one. Idempotent: a flag already on file is not written again.
 */
export async function reconcileTrustedPayouts(
  context: ScopedTenantContext,
  options: PayoutReconOptions,
): Promise<PayoutReconPageResult> {
  const tenantId = context.tenant.tenantId;
  const limit = options.limit ?? PAYOUT_RECON_OPERATIONS_PER_PAGE;
  const { operations, facts, withdrawals, closures, grantsSince } =
    await withTenant(db, context, async (tx) => {
      const trustedSince = rowsOf(
        await tx.execute(sql`SELECT app.payout_trusted_since() AS since`),
      )[0]?.since;
      const since =
        options.since ??
        new Date((trustedSince as string | Date | undefined) ?? NaN);
      if (Number.isNaN(since.getTime()))
        throw new Error("Payout trusted boundary time is unknown");
      const grantsSince = new Date(
        (rowsOf(
          await tx.execute(sql`SELECT app.payout_grants_since() AS since`),
        )[0]?.since as string | Date | undefined) ?? NaN,
      );
      if (Number.isNaN(grantsSince.getTime()))
        throw new Error("Payout grant boundary time is unknown");
      const found = await listOperations(tx, tenantId, {
        after: options.after ?? null,
        limit,
        since,
      });
      const withdrawals =
        options.after == null
          ? await loadWithdrawals(tx, tenantId, grantsSince)
          : null;
      const closures =
        options.after == null ? await loadClosures(tx, tenantId, since) : null;
      if (found.length === 0)
        return {
          operations: found,
          facts: null as Facts | null,
          withdrawals,
          closures,
          grantsSince,
        };
      return {
        operations: found,
        facts: await loadFacts(tx, tenantId, found, since, grantsSince),
        withdrawals,
        closures,
        grantsSince,
      };
    });
  const last = operations.at(-1)?.sortKey ?? null;
  const exhausted = operations.length < limit;
  if (
    facts === null &&
    (withdrawals?.attestations.length ?? 0) === 0 &&
    (withdrawals?.lostResolves.length ?? 0) === 0 &&
    (closures?.closures.length ?? 0) === 0
  )
    return {
      operations: 0,
      flagged: 0,
      reraised: 0,
      reraiseFailed: 0,
      unreadable: 0,
      last,
      exhausted,
    };

  // The stored proof read again must hash to its record. "Not found" is a
  // difference; any other read error is recorded as an `error` observation
  // (1057, legend-qh11l, migration 0674) and holds the slips of the flags of the
  // operation at once (it adds a key to their fingerprint) until a later
  // successful read; it raises no flag of its own and the next cycle reads again.
  // The read and the observation of an operation share one transaction under the
  // advisory lock `app.payout_recon_evidence_observe` takes (1038, 1052): the read
  // happens inside the lock, so the order of the observations is the order of the
  // reads for every run, and whether a recovery (`ok`) is kept is decided by the
  // database at that moment, never by the snapshot taken at the start of the run.
  // A failure to record fails the page (fail closed). The operations are bounded
  // by the page size.
  // What an operation read is kept per operation id (1052): two operations may
  // share an evidence key and each is judged by its own read.
  const fileOf = new Map<string, FileState>();
  let unreadable = 0;
  if (options.storage) {
    const storage = options.storage;
    for (const op of operations) {
      const key = op.evidenceKey;
      const record = key === null ? undefined : facts?.records.get(key);
      if (key === null || !record) continue;
      await withTenant(db, context, async (tx) => {
        await tx.execute(
          sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`payout_recon_evidence_observe:${tenantId}:${op.operationId}`}::text, 0))`,
        );
        let state: FileState;
        let readSha: string | null = null;
        try {
          const object = await storage.get(context, {
            tenantId,
            outletId: null,
            reference: "payout-trusted-recon",
            key,
            visibility: "private",
          });
          readSha = sha256Of(object.content);
          state =
            readSha === (record.stored ?? record.content) ? "ok" : "mismatch";
        } catch (error) {
          if (error instanceof CoreError && error.code === "NOT_FOUND")
            state = "missing";
          else state = "error";
        }
        fileOf.set(op.operationId, state);
        if (state === "error") unreadable += 1;
        if (state === "ok") await recordReadOk(tx, tenantId, op.operationId);
        else
          await tx.execute(
            sql`SELECT app.payout_recon_evidence_observe(${tenantId}::uuid, ${op.operationId}::uuid, ${state}::text, ${state === "mismatch" ? readSha : null}::text)`,
          );
      });
    }
  }

  // A difference of the operation holds every slip of it, so an operation-wide
  // reason is flagged once per terminal item (the flag carries the payslip).
  // Known flags are raised again too (legend-hklnq): `app.payout_recon_flag`
  // inserts nothing for an existing key but records a new fingerprint sighting
  // when the flagged data changed. Only flags new to the table count as fresh.
  const known = new Set([
    ...(facts?.flagged ?? []),
    ...(withdrawals?.flagged ?? []),
    ...(closures?.flagged ?? []),
  ]);
  const seen = new Set<string>();
  const raised = (
    facts === null
      ? []
      : operations
          .flatMap((op) => evaluate(op, facts, fileOf))
          .concat(evaluateGrants(facts))
  )
    .concat(
      withdrawals === null
        ? []
        : evaluateGrants({
            grantsSince: grantsSince.getTime(),
            attestations: withdrawals.attestations,
            grants: withdrawals.grants,
            sourceItems: new Map(),
            resolutions: withdrawals.resolutions,
          }).concat(
            evaluateResolutions(
              withdrawals.attestations,
              withdrawals.resolutions,
              grantsSince.getTime(),
            ),
            withdrawals.lostResolves,
          ),
    )
    .concat(
      closures === null
        ? []
        : [
            ...evaluateClosures(
              closures.closures,
              closures.attestations,
              closures.sessions,
              closures.grants,
            ),
            // An attestation of a closure names no item: the slips it holds.
            ...evaluateGrants({
              grantsSince: grantsSince.getTime(),
              attestations: closures.attestations,
              grants: closures.grants,
              sourceItems: new Map(
                closures.closures.map((c) => [c.id, c.itemIds]),
              ),
              resolutions: new Map(),
            }),
          ],
    )
    .filter((flag) => {
      const key = flagKey(
        flag.kind,
        flag.operationId,
        flag.itemId,
        flag.reason,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const fresh = raised.filter(
    (flag) =>
      !known.has(
        flagKey(flag.kind, flag.operationId, flag.itemId, flag.reason),
      ),
  );
  // New flags first, in their own transaction: a failure fails the page, as before.
  if (fresh.length > 0)
    await withTenant(db, context, async (tx) => {
      for (const flag of fresh)
        await tx.execute(
          sql`SELECT app.payout_recon_flag(${tenantId}::uuid, ${flag.kind}, ${flag.operationId}::uuid, ${flag.itemId}::uuid, ${flag.reason})`,
        );
    });
  // Known flags are raised again in small chunks of their own (each call holds
  // an advisory lock until its transaction ends). A failed chunk is logged and
  // never fails the page or holds the cursor (legend-hklnq).
  const freshKeys = new Set(
    fresh.map((flag) =>
      flagKey(flag.kind, flag.operationId, flag.itemId, flag.reason),
    ),
  );
  const again = await reraiseKnownFlags(
    context,
    raised.filter(
      (flag) =>
        !freshKeys.has(
          flagKey(flag.kind, flag.operationId, flag.itemId, flag.reason),
        ),
    ),
  );
  return {
    operations: operations.length,
    flagged: fresh.length,
    reraised: again.reraised,
    reraiseFailed: again.failed,
    unreadable,
    last,
    exhausted,
  };
}
