// Statement line ↔ book document matching (bead legend-fnxl, WS-07; PRD v1.7
// §3.19 "Pencocokan otomatis ≥ 99%", ACC-04). Kas-bank only: candidates are
// cash deposits into the account and posted journals that move the account's
// GL account. Gateway/EDC settlements join in legend-cs7.
//
// Rules (docs/DECISIONS.md "WS-07 cash & bank reconciliation"):
// - Every caller holds the entity lock (`entityLock`) first: journals belong
//   to the legal entity and its GL account, and two bank accounts may share a
//   GL account, so a per-account lock would let them race for one journal.
// - Automatic match only on an exact amount inside the tenant's
//   `matchingPolicy.dateToleranceDays`, and only when it is unique both ways:
//   the line has exactly one candidate (shared `findStatementMatch`) and that
//   document has exactly one candidate line, counted across every bank
//   account of the entity that shares the GL account. Anything else stays
//   unmatched for a person; nothing is guessed.
// - A pair a person unmatched is remembered in
//   `bank_statement_match_rejections` and never auto-matched again for that
//   line; a manual match of it is still allowed and clears the rejection.
// - A document named in an open / in-progress reconciliation case is not a
//   candidate (auto) and is refused (manual): the case is where it is
//   being discussed.
// - A document matches at most one line: UNIQUE (tenant, ref_type, ref_id) on
//   `bank_statement_line_matches`. Auto inserts use ON CONFLICT DO NOTHING so
//   one collision never aborts an import; manual matches map it to
//   STATEMENT_LINE_ALREADY_MATCHED.
// - Journals that are reversals or reversed, journals already behind a cash
//   deposit (the same money twice) and write-off adjustment journals are never
//   candidates. Nor is the journal of a gateway settlement that is itself
//   matched to a line: that line already paid it (1269 C4a).
// - A cash deposit's date is its local business date in the outlet's time
//   zone, not UTC.

import { sql } from "drizzle-orm";
import {
  AccountingError,
  findStatementMatch,
  type MatchCandidate,
  type MatchingPolicy,
  type ReconciliationRef,
} from "@starter/shared/accounting";
import {
  CoreError,
  DEFAULT_TIME_ZONE,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { BankAccountRow } from "../db/schema/accounting-cash-bank.ts";
import {
  advisoryLock,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { notFound } from "./accounting-cash-bank-shared.ts";

/** Serializes every line/match/deposit write of one legal entity. */
export async function entityLock(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<void> {
  await advisoryLock(
    tx,
    `acc-cashbank:${tenantId.toLowerCase()}:${legalEntityId.toLowerCase()}`,
  );
}

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  (result as { rows: Row[] }).rows ?? [];

const refKey = (ref: ReconciliationRef) => `${ref.type}:${ref.id}`;

/** Case statuses that still hold their documents (`reconciliationCaseStatusSchema`). */
const OPEN_CASE_STATUSES = sql`('open', 'in_progress')`;

/** True when no open case names the document (jsonb `refs` array of {type, id}). */
function notInOpenCase(
  tenantId: string,
  type: string,
  column: ReturnType<typeof sql>,
) {
  return sql`AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_cases c
                        WHERE c.tenant_id = ${tenantId}
                          AND c.status IN ${OPEN_CASE_STATUSES}
                          AND c.refs @> jsonb_build_array(jsonb_build_object(
                                'type', ${type}::text, 'id', (${column})::text)))`;
}

/** Journals that may back a bank movement of this account (see header). */
function journalCandidateSql(
  tenantId: string,
  account: BankAccountRow,
  extra: ReturnType<typeof sql>,
) {
  return sql`
    SELECT je.id, je.entry_date::text AS date,
           SUM(jl.debit_idr - jl.credit_idr)::text AS amount
    FROM journal_entries je
    JOIN journal_lines jl
      ON jl.tenant_id = je.tenant_id AND jl.entry_id = je.id
     AND jl.account_id = ${account.glAccountId}
    WHERE je.tenant_id = ${tenantId}
      AND je.legal_entity_id = ${account.legalEntityId}
      AND je.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM journal_entries r
                      WHERE r.tenant_id = je.tenant_id AND r.reversal_of = je.id)
      AND NOT EXISTS (SELECT 1 FROM cash_deposits d
                      WHERE d.tenant_id = je.tenant_id AND d.journal_entry_id = je.id)
      AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_cases c
                      WHERE c.tenant_id = je.tenant_id
                        AND c.adjustment_journal_entry_id = je.id)
      AND NOT (je.source_type = 'gateway_settlement'
               AND EXISTS (SELECT 1 FROM bank_statement_line_matches gm
                           WHERE gm.tenant_id = je.tenant_id
                             AND gm.ref_type = 'gateway_settlement'
                             AND gm.ref_id::text = je.source_id))
      ${extra}
    GROUP BY je.id, je.entry_date
    HAVING SUM(jl.debit_idr - jl.credit_idr) <> 0`;
}

function depositCandidateSql(
  tenantId: string,
  account: BankAccountRow,
  extra: ReturnType<typeof sql>,
) {
  return sql`
    SELECT d.id, d.status, d.amount_idr::text AS amount,
           (d.deposited_at AT TIME ZONE COALESCE(o.timezone, ${DEFAULT_TIME_ZONE}))::date::text
             AS local_date
    FROM cash_deposits d
    JOIN outlets o ON o.tenant_id = d.tenant_id AND o.id = d.outlet_id
    WHERE d.tenant_id = ${tenantId}
      AND d.bank_account_id = ${account.id}
      ${extra}`;
}

/** Local business date of a deposit, computed in SQL (outlet time zone). */
function depositDate(row: Row): string {
  return row.local_date as string;
}

/**
 * Free candidates (not matched anywhere) of the account inside a posting
 * window. Deposits must still be `recorded`.
 */
async function loadFreeCandidates(
  tx: TenantTransaction,
  tenantId: string,
  account: BankAccountRow,
  window: { from: string; to: string },
): Promise<MatchCandidate[]> {
  const free = (type: string, column: ReturnType<typeof sql>) =>
    sql`AND NOT EXISTS (SELECT 1 FROM bank_statement_line_matches m
                        WHERE m.tenant_id = ${tenantId} AND m.ref_type = ${type}
                          AND m.ref_id = ${column})
        ${notInOpenCase(tenantId, type, column)}`;
  const journals = rowsOf(
    await tx.execute(
      journalCandidateSql(
        tenantId,
        account,
        sql`AND je.entry_date BETWEEN ${window.from}::date AND ${window.to}::date
            ${free("journal_entry", sql`je.id`)}`,
      ),
    ),
  );
  // Deposit window is widened by a day each side for the time zone, then
  // filtered on the local business date below.
  const deposits = rowsOf(
    await tx.execute(
      depositCandidateSql(
        tenantId,
        account,
        sql`AND d.status = 'recorded'
            AND d.deposited_at >= (${window.from}::date - 1)
            AND d.deposited_at < (${window.to}::date + 2)
            ${free("cash_deposit", sql`d.id`)}`,
      ),
    ),
  );
  const candidates: MatchCandidate[] = journals.map((row) => ({
    ref: { type: "journal_entry", id: row.id as string },
    amountIdr: Number(row.amount),
    date: row.date as string,
  }));
  for (const row of deposits) {
    const date = depositDate(row);
    if (date < window.from || date > window.to) continue;
    candidates.push({
      ref: { type: "cash_deposit", id: row.id as string },
      amountIdr: Number(row.amount),
      date,
    });
  }
  return candidates;
}

/**
 * Does a document no line has claimed already book one of these amounts on the
 * account (journals) or the line itself (cash deposits)? Documents in an open
 * case count too: any doubt is the caller's to refuse (1269 C4a).
 */
export async function hasUnmatchedDocument(
  tx: TenantTransaction,
  tenantId: string,
  account: BankAccountRow,
  input: {
    lineAmountIdr: number;
    journalAmountsIdr: readonly number[];
    from: string;
    to: string;
    toleranceDays: number;
  },
): Promise<boolean> {
  const from = shiftDate(input.from, -input.toleranceDays);
  const to = shiftDate(input.to, input.toleranceDays);
  const free = (type: string, column: ReturnType<typeof sql>) =>
    sql`AND NOT EXISTS (SELECT 1 FROM bank_statement_line_matches m
                        WHERE m.tenant_id = ${tenantId} AND m.ref_type = ${type}
                          AND m.ref_id = ${column})`;
  const journals = rowsOf(
    await tx.execute(
      journalCandidateSql(
        tenantId,
        account,
        sql`AND je.entry_date BETWEEN ${from}::date AND ${to}::date
            ${free("journal_entry", sql`je.id`)}`,
      ),
    ),
  );
  if (
    journals.some((row) => input.journalAmountsIdr.includes(Number(row.amount)))
  )
    return true;
  const deposits = rowsOf(
    await tx.execute(
      depositCandidateSql(
        tenantId,
        account,
        sql`AND d.status = 'recorded' ${free("cash_deposit", sql`d.id`)}`,
      ),
    ),
  );
  return deposits.some((row) => {
    const date = depositDate(row);
    return (
      Number(row.amount) === input.lineAmountIdr && date >= from && date <= to
    );
  });
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Validates manual refs and returns them with their amounts and dates.
 * The documents must belong to this bank account / its GL account, be free
 * (not matched to another line), and be of a kas-bank type.
 */
export async function resolveRefs(
  tx: TenantTransaction,
  tenantId: string,
  account: BankAccountRow,
  refs: readonly ReconciliationRef[],
): Promise<MatchCandidate[]> {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(refKey(ref)))
      throw new CoreError(
        "VALIDATION_ERROR",
        "Dokumen yang sama dipilih dua kali.",
      );
    seen.add(refKey(ref));
    if (ref.type !== "journal_entry" && ref.type !== "cash_deposit")
      throw new CoreError(
        "VALIDATION_ERROR",
        "Jenis dokumen ini belum dapat dicocokkan ke mutasi bank.",
      );
  }
  const taken = rowsOf(
    await tx.execute(sql`
      SELECT ref_type, ref_id FROM bank_statement_line_matches
      WHERE tenant_id = ${tenantId}
        AND (ref_type, ref_id) IN (${sql.join(
          refs.map((ref) => sql`(${ref.type}::varchar, ${ref.id}::uuid)`),
          sql`, `,
        )})`),
  );
  if (taken.length > 0)
    throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
  const inCase = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM bank_reconciliation_cases c
      WHERE c.tenant_id = ${tenantId} AND c.status IN ${OPEN_CASE_STATUSES}
        AND (${sql.join(
          refs.map(
            (ref) =>
              sql`c.refs @> ${JSON.stringify([{ type: ref.type, id: ref.id }])}::jsonb`,
          ),
          sql` OR `,
        )})
      LIMIT 1`),
  );
  if (inCase.length > 0)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Dokumen ini sedang dibahas di kasus rekonsiliasi yang masih terbuka.",
    );

  const resolved: MatchCandidate[] = [];
  for (const ref of refs) {
    if (ref.type === "cash_deposit") {
      const [row] = rowsOf(
        await tx.execute(
          sql`${depositCandidateSql(
            tenantId,
            account,
            sql`AND d.id = ${ref.id}`,
          )} FOR UPDATE OF d`,
        ),
      );
      if (!row) throw notFound("Setoran kas");
      if (row.status !== "recorded")
        throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
      resolved.push({
        ref,
        amountIdr: Number(row.amount),
        date: depositDate(row),
      });
      continue;
    }
    const [row] = rowsOf(
      await tx.execute(
        journalCandidateSql(tenantId, account, sql`AND je.id = ${ref.id}`),
      ),
    );
    if (!row) {
      const [exists] = rowsOf(
        await tx.execute(
          sql`SELECT 1 FROM journal_entries WHERE tenant_id = ${tenantId} AND id = ${ref.id}
                AND legal_entity_id = ${account.legalEntityId}`,
        ),
      );
      if (!exists) throw notFound("Jurnal");
      throw new CoreError(
        "VALIDATION_ERROR",
        "Jurnal ini tidak menggerakkan rekening bank tersebut, sudah dibalik, atau sudah tercatat lewat setoran kas.",
      );
    }
    resolved.push({
      ref,
      amountIdr: Number(row.amount),
      date: row.date as string,
    });
  }
  return resolved;
}

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  ((error as { code?: string }).code === "23505" ||
    (error as { cause?: { code?: string } }).cause?.code === "23505");

/**
 * Writes the match rows of one line and moves the line (and any cash deposit
 * among the refs) to matched. The caller holds the entity lock, has the line
 * row FOR UPDATE and has checked the line is `unmatched`.
 * Returns false when an auto match lost a race for a document (nothing
 * written); a manual match throws STATEMENT_LINE_ALREADY_MATCHED instead.
 */
export async function applyMatch(
  tx: TenantTransaction,
  tenantId: string,
  input: {
    bankAccountId: string;
    lineId: string;
    documents: readonly MatchCandidate[];
    source: "auto" | "manual";
    actorId: string;
  },
): Promise<boolean> {
  const values = sql.join(
    input.documents.map(
      (doc) => sql`(${tenantId}, ${input.bankAccountId}, ${input.lineId},
        ${doc.ref.type}, ${doc.ref.id}, ${doc.amountIdr}, ${input.source}, ${input.actorId})`,
    ),
    sql`, `,
  );
  const insert = sql`
    INSERT INTO bank_statement_line_matches
      (tenant_id, bank_account_id, line_id, ref_type, ref_id, amount_idr, source, matched_by)
    VALUES ${values}`;
  if (input.source === "auto") {
    const inserted = rowsOf(
      await tx.execute(
        sql`${insert} ON CONFLICT (tenant_id, ref_type, ref_id) DO NOTHING RETURNING id`,
      ),
    );
    if (inserted.length !== input.documents.length) {
      if (inserted.length > 0)
        await tx.execute(
          sql`DELETE FROM bank_statement_line_matches WHERE tenant_id = ${tenantId}
                AND line_id = ${input.lineId}`,
        );
      return false;
    }
  } else {
    try {
      await tx.execute(sql`${insert}`);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
      throw error;
    }
    // A person chose this pair again: forget an earlier "not this one".
    await tx.execute(sql`
      DELETE FROM bank_statement_match_rejections
      WHERE tenant_id = ${tenantId} AND line_id = ${input.lineId}
        AND (ref_type, ref_id) IN (${sql.join(
          input.documents.map(
            (doc) => sql`(${doc.ref.type}::varchar, ${doc.ref.id}::uuid)`,
          ),
          sql`, `,
        )})`);
  }
  const status = input.source === "auto" ? "auto_matched" : "manually_matched";
  const updated = rowsOf(
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = ${status}, version = version + 1,
          status_changed_by = ${input.actorId}, status_changed_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${input.lineId}
        AND match_status = 'unmatched'
      RETURNING id`),
  );
  if (updated.length !== 1) throw new AccountingError("INVALID_TRANSITION");
  for (const doc of input.documents) {
    if (doc.ref.type !== "cash_deposit") continue;
    const moved = rowsOf(
      await tx.execute(sql`
        UPDATE cash_deposits
        SET status = 'matched', bank_statement_line_id = ${input.lineId},
            version = version + 1
        WHERE tenant_id = ${tenantId} AND id = ${doc.ref.id}
          AND status = 'recorded'
        RETURNING id`),
    );
    if (moved.length !== 1)
      throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
  }
  return true;
}

/**
 * Auto-matches every unmatched line of the account against free documents
 * (two-way unique, see header). Runs after an import and after a cash
 * deposit is recorded, so a deposit recorded after its statement still
 * matches. Caller holds the entity lock. Returns the new auto matches by
 * import id (lines of earlier imports count under their own import).
 */
export async function autoMatchBankAccount(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  account: BankAccountRow,
  policy: MatchingPolicy,
  actorId: string,
): Promise<{ matched: number; byImport: Map<string, number> }> {
  const tenantId = context.tenant.tenantId;
  const byImport = new Map<string, number>();
  // Outlet RLS on cash_deposits would hide other outlets' deposits from an
  // outlet-scoped caller, so a hit could look unique when it is not. Only a
  // tenant-wide caller auto-matches; the next import (tenant scope) catches up.
  if (context.outletScope.kind !== "tenant") return { matched: 0, byImport };
  const lines = rowsOf(
    await tx.execute(sql`
      SELECT id, import_id, posted_on::text AS posted_on, amount_idr::text AS amount
      FROM bank_statement_lines
      WHERE tenant_id = ${tenantId} AND bank_account_id = ${account.id}
        AND match_status = 'unmatched'
      ORDER BY posted_on, id
      FOR UPDATE`),
  ).map((row) => ({
    id: row.id as string,
    importId: row.import_id as string,
    postedOn: row.posted_on as string,
    amountIdr: Number(row.amount),
  }));
  if (lines.length === 0) return { matched: 0, byImport };
  const tolerance = policy.dateToleranceDays;
  const window = {
    from: shiftDate(lines[0].postedOn, -tolerance),
    to: shiftDate(
      lines.reduce(
        (max, line) => (line.postedOn > max ? line.postedOn : max),
        lines[0].postedOn,
      ),
      tolerance,
    ),
  };
  const candidates = await loadFreeCandidates(tx, tenantId, account, window);
  if (candidates.length === 0) return { matched: 0, byImport };

  // Unmatched lines of the other bank accounts of this entity on the same GL
  // account compete for the same journals (deposits belong to one account).
  const siblings = rowsOf(
    await tx.execute(sql`
      SELECT l.id, l.posted_on::text AS posted_on, l.amount_idr::text AS amount
      FROM bank_statement_lines l
      JOIN bank_accounts b ON b.tenant_id = l.tenant_id AND b.id = l.bank_account_id
      WHERE l.tenant_id = ${tenantId} AND l.match_status = 'unmatched'
        AND b.id <> ${account.id}
        AND b.legal_entity_id = ${account.legalEntityId}
        AND b.gl_account_id = ${account.glAccountId}
        AND l.posted_on BETWEEN ${shiftDate(window.from, -tolerance)}::date
                            AND ${shiftDate(window.to, tolerance)}::date`),
  ).map((row) => ({
    id: row.id as string,
    postedOn: row.posted_on as string,
    amountIdr: Number(row.amount),
  }));

  // Pairs a person already rejected (per line).
  const rejected = new Set<string>();
  const lineIds = [...lines, ...siblings].map((line) => line.id);
  for (const row of rowsOf(
    await tx.execute(sql`
      SELECT line_id, ref_type, ref_id FROM bank_statement_match_rejections
      WHERE tenant_id = ${tenantId}
        AND line_id IN (${sql.join(
          lineIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`),
  ))
    rejected.add(`${row.line_id}|${row.ref_type}:${row.ref_id}`);
  const allowed = (lineId: string, candidate: MatchCandidate) =>
    !rejected.has(`${lineId}|${refKey(candidate.ref)}`);

  // Line side: the shared matcher. Document side: how many lines want it.
  const outcomes = lines.map((line) => ({
    line,
    outcome: findStatementMatch(
      line,
      candidates.filter((candidate) => allowed(line.id, candidate)),
      policy,
    ),
  }));
  const wanted = new Map<string, number>();
  const want = (
    line: (typeof lines)[number] | (typeof siblings)[number],
    candidate: MatchCandidate,
  ) => {
    if (!allowed(line.id, candidate)) return;
    if (findStatementMatch(line, [candidate], policy).kind !== "auto") return;
    wanted.set(
      refKey(candidate.ref),
      (wanted.get(refKey(candidate.ref)) ?? 0) + 1,
    );
  };
  for (const line of lines)
    for (const candidate of candidates) want(line, candidate);
  for (const line of siblings)
    for (const candidate of candidates)
      if (candidate.ref.type === "journal_entry") want(line, candidate);

  let matched = 0;
  for (const { line, outcome } of outcomes) {
    if (outcome.kind !== "auto") continue;
    if (wanted.get(refKey(outcome.ref)) !== 1) continue;
    const document = candidates.find(
      (candidate) => refKey(candidate.ref) === refKey(outcome.ref),
    )!;
    const ok = await applyMatch(tx, tenantId, {
      bankAccountId: account.id,
      lineId: line.id,
      documents: [document],
      source: "auto",
      actorId,
    });
    if (!ok) continue;
    matched += 1;
    byImport.set(line.importId, (byImport.get(line.importId) ?? 0) + 1);
  }
  return { matched, byImport };
}
