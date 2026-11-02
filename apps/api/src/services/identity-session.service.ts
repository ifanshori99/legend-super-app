// Legend session policy on top of Better Auth's session row (PRD v1.7 §3 F6
// "Sesi & Perangkat"; AUTH-05). The pure decisions live in
// @starter/shared/identity (sessionGate, recordSessionActivity,
// newSessionExpiry); this module loads and writes the row.
//
// - A customer session lasts 90 days from sign-in; a management session ends
//   after 30 idle minutes, so its `expires_at` is pushed by activity.
// - A session is management once it opens a guarded surface (back office,
//   dashboard, platform). `kind` records that; the effective kind is also
//   recomputed from the caller's active role assignments, so the idle rule
//   cannot be dodged by a session that was never upgraded.
// - Revoking a device sets `revoked_at` and expires the row immediately, so
//   Better Auth (and therefore every route) rejects it on the next request.
//
// `token` stays Better Auth's raw token; §6 B's token_hash is the one
// deliberate deviation (see db/schema/session.ts and the bead report).

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  MANAGEMENT_IDLE_MINUTES,
  MINUTE_MS,
  newSessionExpiry,
  recordSessionActivity,
  sessionGate,
  sessionIdSchema,
  sessionSchema,
  type Session,
  type SessionGate,
  type SessionView,
} from "@starter/shared/identity";
import { db } from "../db";
import { session } from "../db/schema";
import { HttpError } from "../lib/http-error";

export type SessionRow = typeof session.$inferSelect;

const UNKNOWN_DEVICE = "Perangkat tidak dikenal";

/** Human label for the device list; derived from the stored user agent. */
export function deviceLabelFor(userAgent: string | null): string {
  if (!userAgent) return UNKNOWN_DEVICE;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /iPhone|iPad|iOS/.test(userAgent)
      ? "iOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser === null && os === null) return UNKNOWN_DEVICE;
  return [browser, os].filter((part) => part !== null).join(" · ");
}

export function toWireSession(row: SessionRow): Session {
  return sessionSchema.parse({
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    kind: row.kind === "management" ? "management" : "customer",
    deviceLabel: row.deviceLabel ?? deviceLabelFor(row.userAgent),
    createdAt: row.createdAt.toISOString(),
    // `last_seen_at` defaults to the database clock while Better Auth stamps
    // `created_at` with the API clock; a skew of a few ms between them must
    // not make the row fail the contract (lastSeenAt >= createdAt) and lock
    // the user out with a 422.
    lastSeenAt: new Date(
      Math.max(row.lastSeenAt.getTime(), row.createdAt.getTime()),
    ).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    mfaVerifiedAt: row.mfaVerifiedAt?.toISOString() ?? null,
  });
}

/**
 * The session as the policy sees it. A management session's idle deadline is
 * `last_seen_at + 30 min`, even before activity ever wrote it, so an idle
 * manager is logged out on their first request back.
 */
export function sessionPolicy(input: {
  readonly row: SessionRow;
  readonly management: boolean;
  readonly mfaRequired: boolean;
  readonly now: Date;
}): { readonly session: Session; readonly gate: SessionGate } {
  const wire = toWireSession(input.row);
  const idleDeadline =
    Date.parse(wire.lastSeenAt) + MANAGEMENT_IDLE_MINUTES * MINUTE_MS;
  const expiresAt =
    input.management && idleDeadline < Date.parse(wire.expiresAt)
      ? new Date(idleDeadline).toISOString()
      : wire.expiresAt;
  const policySession: Session = {
    ...wire,
    kind: input.management ? "management" : wire.kind,
    expiresAt,
  };
  return {
    session: policySession,
    gate: sessionGate({
      session: policySession,
      mfaRequired: input.mfaRequired,
      now: input.now,
    }),
  };
}

export async function loadSessionRow(
  sessionId: string,
): Promise<SessionRow | null> {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) return null;
  const [row] = await db
    .select()
    .from(session)
    .where(eq(session.id, parsed.data))
    .limit(1);
  return row ?? null;
}

/**
 * Records user activity. A management session's idle deadline moves forward
 * (at most one write a minute); a customer session only touches `last_seen_at`.
 * Opening a guarded surface upgrades a customer session to management.
 */
export async function touchSession(input: {
  readonly row: SessionRow;
  readonly management: boolean;
  readonly now: Date;
  readonly tx?: Pick<typeof db, "update">;
}): Promise<void> {
  const { row, management, now } = input;
  const writer = input.tx ?? db;
  if (row.revokedAt !== null) return;
  if (row.expiresAt.getTime() <= now.getTime()) return;
  if (management && row.kind !== "management") {
    await writer
      .update(session)
      .set({
        kind: "management",
        lastSeenAt: now,
        expiresAt: newSessionExpiry("management", now),
      })
      .where(eq(session.id, row.id));
    return;
  }
  const wire = toWireSession(row);
  const activity = recordSessionActivity({
    session: { ...wire, kind: management ? "management" : wire.kind },
    now,
    kind: "user",
  });
  if (!activity.write) return;
  await writer
    .update(session)
    .set({
      lastSeenAt: new Date(activity.session.lastSeenAt),
      expiresAt: new Date(activity.session.expiresAt),
    })
    .where(eq(session.id, row.id));
}

/** AUTH-05: a staff session may extend only while its idle window is live.
 * Lock the row through the check and throttled activity write so concurrent
 * extensions or revocations cannot resurrect it. */
export async function extendCurrentSession(input: {
  readonly sessionId: string;
  readonly userId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(session)
      .where(
        and(eq(session.id, input.sessionId), eq(session.userId, input.userId)),
      )
      .for("update");
    const now = new Date();
    if (
      !row ||
      row.revokedAt ||
      sessionPolicy({ row, management: true, mfaRequired: false, now }).gate !==
        "ok"
    )
      throw new HttpError(401, "UNAUTHORIZED", "Sesi berakhir. Masuk lagi.");
    // Only sessions that have entered a guarded staff surface are management.
    if (row.kind !== "management")
      throw new HttpError(403, "FORBIDDEN", "Sesi staf diperlukan.");
    await touchSession({ row, management: true, now, tx });
  });
}

/** The caller's device list, newest activity first. Own sessions only. */
export async function listOwnSessions(input: {
  readonly userId: string;
  readonly currentSessionId: string;
  readonly now?: Date;
}): Promise<SessionView[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(session)
    .where(
      and(
        eq(session.userId, input.userId),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
      ),
    )
    .orderBy(desc(session.lastSeenAt));
  return rows.map((row) => ({
    session: toWireSession(row),
    current: row.id === input.currentSessionId,
  }));
}

/**
 * Revokes one device's session. A session of another user is answered exactly
 * like a missing one (404), so ids cannot be probed. Idempotent: revoking an
 * already revoked session returns its wire shape unchanged.
 */
export async function revokeOwnSession(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly now?: Date;
}): Promise<Session> {
  const now = input.now ?? new Date();
  const parsed = sessionIdSchema.safeParse(input.sessionId);
  if (!parsed.success) throw sessionNotFound();
  const [row] = await db
    .select()
    .from(session)
    .where(and(eq(session.id, parsed.data), eq(session.userId, input.userId)))
    .limit(1);
  if (!row) throw sessionNotFound();
  if (row.revokedAt !== null) return toWireSession(row);
  // Better Auth rejects a session whose expires_at has passed, so revoking
  // expires the row at creation + 1 ms: still after created_at (the §6 shape
  // the wire schema requires) and in the past for any session older than a
  // millisecond. `revoked_at` keeps the audit trail.
  const expiresAt = new Date(row.createdAt.getTime() + 1);
  await db
    .update(session)
    .set({ revokedAt: now, expiresAt })
    .where(eq(session.id, row.id));
  return toWireSession({ ...row, revokedAt: now, expiresAt });
}

/** Same status as a missing row and as another user's row (no enumeration). */
function sessionNotFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Sesi tidak ditemukan.");
}
