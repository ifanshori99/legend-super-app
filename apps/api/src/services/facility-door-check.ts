// Door check (936 second-opinion fix, group T; contract
// `doorCheckAccessTicket` in @starter/shared/facility). The smallest cloud
// validator of the QR token or PIN a paid ticket was given
// (`issuePosTicketCredential` in facility-pos-tickets.ts). There was no door
// check before: a revoked, rotated or refunded credential could not be told
// from a good one by anything. Edge offline readers and lock hardware (bead
// legend-bzih) are NOT built here.
//
// Rules, all answered by ONE uniform 403 DOOR_CREDENTIAL_INVALID (a caller must
// not learn which part was wrong): unknown token, wrong PIN, a rotated (not
// newest) pair, a revoked pair (refund, void), outside the credential window,
// a ticket that is not `issued` or `in_use`, another tenant's ticket (the
// lookup is tenant filtered and RLS hides other outlets). A refused check
// writes nothing.
//
// Concurrency: the ticket row is locked FOR UPDATE, the same lock the mint, the
// refund and the void take before they touch the credential, so a check can
// never pass on a pair that a rotation or a refund is replacing. The credential
// is read again under that lock. A first success moves `issued` to `in_use` and
// records `first_opened_at` once; a repeat check (guest re-enters) answers 200
// and changes nothing.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  isWithinCredentialWindow,
  transitionTicket,
  type AccessTicket,
  type DoorCheckAccessTicketBody,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { accessTickets } from "../db/schema/facility.ts";
import {
  accessTicketCredentials,
  accessTicketPinGuesses,
} from "../db/schema/facility-pos-ticket.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { auditFacility, toTicket } from "./facility-shared.ts";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

// Refusals AFTER the PIN matched the stored digest (facility, window, status,
// revoke): the guest had the right PIN, so the PIN limit must not count them.
// The reply is the same uniform 403; only this module can tell them apart.
const afterPinMatch = new WeakSet<HttpError>();

function invalidCredential(options: { pinMatched?: boolean } = {}): HttpError {
  const error = new HttpError(
    403,
    "DOOR_CREDENTIAL_INVALID",
    "Kredensial pintu tidak valid.",
  );
  if (options.pinMatched === true) afterPinMatch.add(error);
  return error;
}

// PIN guess limit: a 6-digit PIN has only 10^6 values, so the wrong PINs of the
// PIN path are counted per tenant + ticket. Five wrong PINs in 15 minutes lock
// the PIN path of that ticket (even the right PIN answers 429); the QR path and
// other tickets are not affected. The counter lives in the database
// (`access_ticket_pin_guesses`, migration 0676, R2-04 / legend-0xt77): every
// instance shares it, nothing evicts a row, and a row exists only for a real
// ticket, so churn of unknown ticket ids can neither fill nor reset it. Each
// reservation and release commits in its own short transaction OUTSIDE the
// check transaction, which rolls back when the check throws.
export const DOOR_PIN_MAX_FAILURES = 5;
export const DOOR_PIN_WINDOW_MS = 15 * 60 * 1000;
const DOOR_PIN_WINDOW_SECONDS = DOOR_PIN_WINDOW_MS / 1000;

type PinAttempt =
  { locked: true } | { locked: false; release: () => Promise<void> };

/**
 * Reserves one PIN guess for the ticket before the check, atomically (the row
 * lock of the upsert serialises concurrent guesses, so none slips past the
 * limit). An id with no ticket reserves nothing: the lookup fails anyway and
 * no row is written for it.
 */
async function reservePinAttempt(
  context: ScopedTenantContext,
  ticketId: string,
): Promise<PinAttempt> {
  const tenantId = context.tenant.tenantId;
  const ticketUuid = ulidToUuid(ticketId);
  return withTenant(db, context, async (tx) => {
    const reserved = await tx.execute(sql`
      INSERT INTO access_ticket_pin_guesses AS g
        (tenant_id, outlet_id, access_ticket_id, window_started_at, failures, updated_at)
      SELECT t.tenant_id, t.outlet_id, t.id, clock_timestamp(), 1, clock_timestamp()
        FROM access_tickets t
       WHERE t.tenant_id = ${tenantId} AND t.id = ${ticketUuid}
      ON CONFLICT (tenant_id, access_ticket_id) DO UPDATE SET
        window_started_at = CASE
          WHEN g.window_started_at + make_interval(secs => ${DOOR_PIN_WINDOW_SECONDS}) <= clock_timestamp()
          THEN clock_timestamp() ELSE g.window_started_at END,
        failures = CASE
          WHEN g.window_started_at + make_interval(secs => ${DOOR_PIN_WINDOW_SECONDS}) <= clock_timestamp()
          THEN 1 ELSE g.failures + 1 END,
        updated_at = clock_timestamp()
      WHERE g.window_started_at + make_interval(secs => ${DOOR_PIN_WINDOW_SECONDS}) <= clock_timestamp()
         OR g.failures < ${DOOR_PIN_MAX_FAILURES}
      RETURNING window_started_at::text AS window_started_at
    `);
    const row = reserved.rows[0] as { window_started_at: string } | undefined;
    if (!row) {
      // Nothing reserved: the ticket is unknown (no lock) or its window is
      // full (locked).
      const [full] = await tx
        .select({ id: accessTicketPinGuesses.id })
        .from(accessTicketPinGuesses)
        .where(
          and(
            eq(accessTicketPinGuesses.tenantId, tenantId),
            eq(accessTicketPinGuesses.accessTicketId, ticketId),
          ),
        )
        .limit(1);
      return full
        ? { locked: true as const }
        : { locked: false as const, release: async () => {} };
    }
    const windowStartedAt = row.window_started_at;
    return {
      locked: false as const,
      // Hands the guess back (the PIN was right) when it is still in the
      // window it was reserved in.
      release: () =>
        withTenant(db, context, async (releaseTx) => {
          await releaseTx.execute(sql`
            UPDATE access_ticket_pin_guesses
               SET failures = GREATEST(failures - 1, 0),
                   updated_at = clock_timestamp()
             WHERE tenant_id = ${tenantId}
               AND access_ticket_id = ${ticketUuid}
               AND window_started_at = ${windowStartedAt}::timestamptz
          `);
        }),
    };
  });
}

/**
 * POST /api/facility/tickets/door-check. The caller (route) checked the door
 * staff permission; the context carries the caller's outlet reach.
 */
export async function doorCheckTicket(
  context: ScopedTenantContext,
  actorUserId: string,
  input: DoorCheckAccessTicketBody,
): Promise<{ ticket: AccessTicket }> {
  if (!("ticketId" in input))
    return checkCredential(context, actorUserId, input);
  // One attempt is reserved BEFORE the check (so concurrent guesses cannot
  // slip past the limit) and handed back unless the credential was wrong.
  const attempt = await reservePinAttempt(context, input.ticketId);
  // Locked: refused before any lookup, so even the right PIN opens nothing.
  if (attempt.locked)
    throw new HttpError(
      429,
      "DOOR_PIN_LOCKED",
      "Terlalu banyak PIN salah untuk tiket ini; gunakan QR atau tunggu.",
    );
  try {
    const result = await checkCredential(context, actorUserId, input);
    // The door is already open: a failed hand-back must not turn this 200 into
    // a 500 (the slot just stays used until it ages out).
    try {
      await attempt.release();
    } catch (releaseError) {
      logger.warn(
        { err: releaseError, ticketId: input.ticketId },
        "door PIN attempt release failed after the door opened",
      );
    }
    return result;
  } catch (error) {
    // Keep the slot only when the PIN itself was wrong.
    if (!(
      error instanceof HttpError &&
      error.code === "DOOR_CREDENTIAL_INVALID" &&
      !afterPinMatch.has(error)
    ))
      await attempt.release();
    throw error;
  }
}

async function checkCredential(
  context: ScopedTenantContext,
  actorUserId: string,
  input: DoorCheckAccessTicketBody,
): Promise<{ ticket: AccessTicket }> {
  const tenantId = context.tenant.tenantId;
  // Same digests as the mint (facility-pos-tickets.ts): the QR token alone, or
  // the PIN bound to its ticket id.
  const presented =
    "qrToken" in input
      ? ({ kind: "qr", digest: sha256(input.qrToken) } as const)
      : ({
          kind: "pin",
          ticketId: input.ticketId,
          digest: sha256(`${input.ticketId}:${input.pin}`),
        } as const);
  return withTenant(db, context, async (tx) => {
    // Find the ticket the credential belongs to (not locked yet).
    const [found] = await tx
      .select({ ticketId: accessTicketCredentials.accessTicketId })
      .from(accessTicketCredentials)
      .where(
        and(
          eq(accessTicketCredentials.tenantId, tenantId),
          presented.kind === "qr"
            ? eq(accessTicketCredentials.qrDigest, presented.digest)
            : and(
                eq(accessTicketCredentials.accessTicketId, presented.ticketId),
                eq(accessTicketCredentials.pinDigest, presented.digest),
              ),
        ),
      )
      .limit(1);
    if (!found) throw invalidCredential();

    const [row] = await tx
      .select()
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, found.ticketId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw invalidCredential();
    // The door clock is the database clock, read AFTER the ticket lock (R2-03):
    // a check that waited for the lock behind a rotation or a refund must judge
    // the credential window at the moment it holds the lock, not at request
    // arrival. clock_timestamp() (not now()) because now() is the transaction
    // start, before the wait.
    const clock = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const now = new Date((clock.rows[0] as { now: Date | string }).now);
    // Read again under the ticket lock: a rotation or a revoke may have landed
    // between the lookup and the lock.
    const [credential] = await tx
      .select()
      .from(accessTicketCredentials)
      .where(
        and(
          eq(accessTicketCredentials.tenantId, tenantId),
          eq(accessTicketCredentials.accessTicketId, row.id),
        ),
      )
      .limit(1);
    // The pair is not the newest one (rotated meanwhile): a wrong credential.
    if (
      !credential ||
      (presented.kind === "qr" ? credential.qrDigest : credential.pinDigest) !==
        presented.digest
    )
      throw invalidCredential();
    // From here the presented token or PIN IS the stored one.
    if (
      credential.revokedAt !== null ||
      !isWithinCredentialWindow(
        {
          validFrom: credential.validFrom.toISOString(),
          validUntil: credential.validUntil.toISOString(),
        },
        now,
      ) ||
      (row.status !== "issued" && row.status !== "in_use") ||
      // The reader's facility must be the ticket's: same uniform refusal.
      row.facilityId !== input.facilityId
    )
      throw invalidCredential({ pinMatched: true });

    if (row.status === "in_use") return { ticket: toTicket(row) };

    const status = transitionTicket(row.status, "open");
    const [opened] = await tx
      .update(accessTickets)
      .set({
        status,
        firstOpenedAt: row.firstOpenedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, row.id),
          eq(accessTickets.status, "issued"),
        ),
      )
      .returning();
    if (!opened) throw invalidCredential({ pinMatched: true });
    // Never audit the token or the PIN: only that the door opened the ticket.
    await auditFacility(tx, context, actorUserId, now, {
      action: "access_ticket.door_opened",
      objectType: "access_ticket",
      objectId: row.id,
      outletId: row.outletId,
      before: { ticketId: row.id, status: row.status },
      after: { ticketId: row.id, status },
    });
    return { ticket: toTicket(opened) };
  });
}
