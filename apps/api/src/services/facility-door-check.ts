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
import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  isWithinCredentialWindow,
  transitionTicket,
  type AccessTicket,
  type DoorCheckAccessTicketBody,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { accessTickets } from "../db/schema/facility.ts";
import { accessTicketCredentials } from "../db/schema/facility-pos-ticket.ts";
import { withTenant } from "../db/tenant.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import { HttpError } from "../lib/http-error.ts";
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
// other tickets are not affected. The counter is process-local (like the other
// fixed-window limits); the count lives OUTSIDE the transaction, which rolls
// back when the check throws.
export const DOOR_PIN_MAX_FAILURES = 5;
export const DOOR_PIN_WINDOW_MS = 15 * 60 * 1000;
const pinFailures = createFixedWindowCounter({
  limit: DOOR_PIN_MAX_FAILURES,
  windowMs: DOOR_PIN_WINDOW_MS,
  capacity: 10_000,
});

const pinFailureKey = (tenantId: string, ticketId: string) =>
  `${tenantId}:${ticketId}`;

/**
 * POST /api/facility/tickets/door-check. The caller (route) checked the door
 * staff permission; the context carries the caller's outlet reach.
 */
export async function doorCheckTicket(
  context: ScopedTenantContext,
  actorUserId: string,
  input: DoorCheckAccessTicketBody,
  now = new Date(),
): Promise<{ ticket: AccessTicket }> {
  if (!("ticketId" in input))
    return checkCredential(context, actorUserId, input, now);
  // One attempt is reserved BEFORE the check (so concurrent guesses cannot
  // slip past the limit) and handed back unless the credential was wrong.
  const attempt = pinFailures.reserve(
    pinFailureKey(context.tenant.tenantId, input.ticketId),
    now.getTime(),
  );
  // Locked: refused before any lookup, so even the right PIN opens nothing.
  if (attempt.retryAfter !== null)
    throw new HttpError(
      429,
      "DOOR_PIN_LOCKED",
      "Terlalu banyak PIN salah untuk tiket ini; gunakan QR atau tunggu.",
    );
  try {
    const result = await checkCredential(context, actorUserId, input, now);
    attempt.release();
    return result;
  } catch (error) {
    // Keep the slot only when the PIN itself was wrong.
    if (!(
      error instanceof HttpError &&
      error.code === "DOOR_CREDENTIAL_INVALID" &&
      !afterPinMatch.has(error)
    ))
      attempt.release();
    throw error;
  }
}

async function checkCredential(
  context: ScopedTenantContext,
  actorUserId: string,
  input: DoorCheckAccessTicketBody,
  now: Date,
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
