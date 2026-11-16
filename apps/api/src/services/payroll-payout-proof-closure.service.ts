// Payroll payout: close a stuck proof key (bead legend-6htrf, 905 card 3).
// A key the fingerprint backfill could not complete (unreadable, hash_conflict,
// legacy_duplicate, shared_key, bind_failed) holds the global proof gate
// `app.payout_proof_history_pending()` until it is resolved. Two different
// finance people close it: one proposes, the other approves. The proof stays
// bound for good: closing never changes an item and never opens a payment.
// - The money-adjacent rules live in the SQL functions owned by `legend_payout`
//   (migration 0413): `app.payout_proof_closure_propose` / `_approve` check the
//   actor and session, the two-person rule (approver is neither the proposer
//   nor the batch requester), idempotence, and contest every known hash. This
//   file only calls them, lists the stuck keys, and maps their refusals.
// - A refusal raised by the database carries its code in the message; it is
//   mapped to the HTTP status below. Anything else is rethrown untouched.

import { sql } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  type TenantId,
} from "@starter/shared/core";
import type {
  PayoutProofClosureClosedDto,
  PayoutProofClosureProposedDto,
  PayoutStuckProof,
} from "@starter/shared/types";
import type { ListPayoutStuckProofsQuery } from "@starter/shared/validators/payroll-payout";
import type { Tx } from "./hris-access.ts";
import {
  payoutRefuse,
  payoutTrustedGrant,
  recordPayoutAudit,
  type PayoutActor as Actor,
} from "./payroll-payout.service.ts";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Emitted by `to_char(... AT TIME ZONE 'UTC', ...)`; keeps the microseconds. */
const CURSOR_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  (result as { rows?: Row[] }).rows ?? [];

/** Refusals the SQL functions raise, by the code in their message. */
const SQL_REFUSALS: ReadonlyArray<{
  code: string;
  status: number;
  message: string;
}> = [
  {
    code: "PAYOUT_PROOF_STUCK_NOT_FOUND",
    status: 404,
    message: "Bukti macet tidak ditemukan atau sudah selesai.",
  },
  {
    code: "PAYOUT_CLOSURE_SAME_PERSON",
    status: 403,
    message: "Penutupan harus disetujui orang yang berbeda dari pengusulnya.",
  },
  {
    code: "PAYOUT_CLOSURE_REQUESTER",
    status: 403,
    message:
      "Pemohon batch pembayaran tidak boleh menyetujui penutupan bukti ini.",
  },
  {
    code: "PAYOUT_CLOSURE_ALREADY_CLOSED",
    status: 409,
    message: "Bukti ini sudah ditutup.",
  },
  {
    code: "PAYOUT_PROOF_CLOSED",
    status: 409,
    message: "Bukti ini sudah ditutup dan tidak bisa dipakai lagi.",
  },
];

/** Walks the error chain; the first message that holds a known code wins. */
function mapClosureRefusal(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const { message } = current as { message?: unknown };
    if (typeof message === "string") {
      const hit = SQL_REFUSALS.find((r) => message.includes(r.code));
      if (hit) return payoutRefuse(hit.status, hit.code, hit.message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

const invalidCursor = () =>
  payoutRefuse(422, "VALIDATION_ERROR", "Kursor tidak valid.");

/** Rejects impossible dates the regex lets through (month 13, year 0). */
function isRealTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() >= 1 &&
    date.toISOString().slice(0, 19) === match[1]
  );
}

function readCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  if (
    keys.length !== 2 ||
    typeof keys[0] !== "string" ||
    typeof keys[1] !== "string" ||
    !isRealTimestamp(keys[0]) ||
    !UUID_SHAPE.test(keys[1])
  )
    throw invalidCursor();
  return [keys[0], keys[1]];
}

/**
 * Stuck proof keys of the tenant that are not resolved yet, newest first,
 * keyset paged on (first_seen_at, id). The closure column joins the closure
 * row of the key (proposed or closed) when there is one.
 */
export async function listStuckProofs(
  tx: Tx,
  tenantId: TenantId,
  query: ListPayoutStuckProofsQuery,
): Promise<{ items: PayoutStuckProof[]; nextCursor: string | null }> {
  const after = readCursor(query.cursor);
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT s.id, s.evidence_key, s.batch_id, s.reason, s.attempts,
                 s.first_seen_at,
                 to_char(s.first_seen_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
                 c.id AS closure_id, c.proposed_at AS closure_proposed_at,
                 c.closed_at AS closure_closed_at
            FROM payroll_payout_proof_backfill_stuck s
            LEFT JOIN payroll_payout_proof_closures c
              ON c.tenant_id = s.tenant_id AND c.evidence_key = s.evidence_key
           WHERE s.tenant_id = ${tenantId}::uuid
             AND s.resolved_at IS NULL
             ${
               after
                 ? sql`AND (s.first_seen_at, s.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
                 : sql``
             }
           ORDER BY s.first_seen_at DESC, s.id DESC
           LIMIT ${query.limit + 1}`,
    ),
  );
  const page = rows.slice(0, query.limit);
  const items = page.map((row): PayoutStuckProof => {
    const closureId = row.closure_id as string | null;
    const closedAt = row.closure_closed_at as Date | string | null;
    return {
      evidenceKey: row.evidence_key as string,
      batchId: row.batch_id as string,
      reason: row.reason as PayoutStuckProof["reason"],
      attempts: Number(row.attempts),
      firstSeenAt: new Date(row.first_seen_at as Date | string).toISOString(),
      closure: closureId
        ? {
            id: closureId,
            stage: closedAt ? "closed" : "proposed",
            proposedAt: new Date(
              row.closure_proposed_at as Date | string,
            ).toISOString(),
            closedAt: closedAt ? new Date(closedAt).toISOString() : null,
          }
        : null,
    };
  });
  const last = rows.length > query.limit ? page[page.length - 1] : undefined;
  return {
    items,
    nextCursor: last
      ? encodeCursor([last.cursor_at as string, last.id as string])
      : null,
  };
}

/** Step one: a finance person proposes to close a stuck key, with a note. */
export async function proposeProofClosure(
  tx: Tx,
  actor: Actor,
  input: { evidenceKey: string; note: string },
): Promise<PayoutProofClosureProposedDto> {
  const [stuck] = rowsOf(
    await tx.execute(
      sql`SELECT batch_id FROM payroll_payout_proof_backfill_stuck
           WHERE tenant_id = ${actor.tenantId}::uuid
             AND evidence_key = ${input.evidenceKey}
             AND resolved_at IS NULL
           LIMIT 1`,
    ),
  );
  if (!stuck)
    throw payoutRefuse(
      404,
      "PAYOUT_PROOF_STUCK_NOT_FOUND",
      "Bukti macet tidak ditemukan atau sudah selesai.",
    );
  let closureId: string;
  try {
    const grant = await payoutTrustedGrant(actor, {
      kind: "closure",
      step: "propose",
      batchId: stuck.batch_id as string,
      itemIds: [],
      evidenceKey: input.evidenceKey,
      refId: null,
      targetId: null,
    });
    const [row] = rowsOf(
      await tx.execute(
        sql`SELECT app.payout_proof_closure_propose(${input.evidenceKey}::varchar, ${input.note}, ${grant}) AS id`,
      ),
    );
    closureId = row!.id as string;
  } catch (error) {
    throw mapClosureRefusal(error);
  }
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.proof_closure_proposed",
    objectType: "payroll_payout_proof_closure",
    objectId: closureId,
    reason: input.note,
    before: { stage: null },
    after: { stage: "proposed", evidenceKey: input.evidenceKey },
  });
  return { closureId, stage: "proposed" };
}

/**
 * Step two: a different finance person closes it. Idempotent: a closure that
 * is already closed gives the same result. `gatePending` tells whether any
 * proof still holds the global gate afterwards.
 */
export async function approveProofClosure(
  tx: Tx,
  actor: Actor,
  closureId: string,
): Promise<PayoutProofClosureClosedDto> {
  // The grant binds the batch the key is stuck on and the closure's key; the
  // stuck row is kept after the closure is closed, so a repeat still finds it.
  const [bound] = rowsOf(
    await tx.execute(
      sql`SELECT s.batch_id, z.evidence_key
            FROM payroll_payout_proof_closures z
            JOIN payroll_payout_proof_backfill_stuck s
              ON s.tenant_id = z.tenant_id AND s.evidence_key = z.evidence_key
           WHERE z.tenant_id = ${actor.tenantId}::uuid
             AND z.id = ${closureId}::uuid
           LIMIT 1`,
    ),
  );
  if (!bound)
    throw payoutRefuse(
      404,
      "PAYOUT_PROOF_STUCK_NOT_FOUND",
      "Bukti macet tidak ditemukan atau sudah selesai.",
    );
  try {
    const grant = await payoutTrustedGrant(actor, {
      kind: "closure",
      step: "approve",
      batchId: bound.batch_id as string,
      itemIds: [],
      evidenceKey: bound.evidence_key as string,
      refId: closureId,
      targetId: null,
    });
    await tx.execute(
      sql`SELECT app.payout_proof_closure_approve(${closureId}::uuid, ${grant}) AS closed`,
    );
  } catch (error) {
    throw mapClosureRefusal(error);
  }
  const [gate] = rowsOf(
    await tx.execute(sql`SELECT app.payout_proof_history_pending() AS pending`),
  );
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.proof_closure_closed",
    objectType: "payroll_payout_proof_closure",
    objectId: closureId,
    before: { stage: "proposed" },
    after: { stage: "closed" },
  });
  return { closureId, stage: "closed", gatePending: gate?.pending === true };
}
