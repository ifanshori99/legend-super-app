// Shared fixtures for member-feedback.test.ts and crm-feedback.test.ts
// (legend-ts50). Not a test file. Raw SQL as the migration owner, inside the
// tenant GUCs (asTenant); the code under test runs as legend_app over HTTP.
//
// Column names of `feedback` are the snake_case fields of `feedbackSchema`
// plus `handled_note` (brief 304a). `feedback.order_id` is assumed to hold the
// order UUID (ulidToUuid of the order ULID), like `orders.id`.

import { randomUUID } from "node:crypto";
import { ulidToUuid } from "@starter/shared/core";
import { seededOutletA, seededTenantId } from "./floor-test-helpers";
import { asTenant, seedOrder } from "./member-loyalty-helpers.ts";

export type FeedbackRow = {
  id: string;
  outlet_id: string;
  table_session_id: string | null;
  customer_profile_id: string | null;
  order_id: string | null;
  kind: "rating" | "complaint";
  rating: number | null;
  comment: string | null;
  status: "open" | "in_review" | "resolved" | "closed";
  handled_by: string | null;
  handled_note: string | null;
  resolved_at: Date | null;
};

const COLUMNS = `id, outlet_id, table_session_id, customer_profile_id, order_id, kind,
  rating, comment, status, handled_by, handled_note, resolved_at`;

export async function feedbackById(id: string): Promise<FeedbackRow | null> {
  const { rows } = await asTenant(seededTenantId, (client) =>
    client.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback WHERE tenant_id = $1 AND id = $2`,
      [seededTenantId, id],
    ),
  );
  return rows[0] ?? null;
}

export async function feedbackOfOrder(
  orderUlid: string,
): Promise<FeedbackRow[]> {
  const { rows } = await asTenant(seededTenantId, (client) =>
    client.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback WHERE tenant_id = $1 AND order_id = $2`,
      [seededTenantId, ulidToUuid(orderUlid)],
    ),
  );
  return rows;
}

export async function feedbackOfSession(
  sessionId: string,
): Promise<FeedbackRow[]> {
  const { rows } = await asTenant(seededTenantId, (client) =>
    client.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM feedback WHERE tenant_id = $1 AND table_session_id = $2`,
      [seededTenantId, sessionId],
    ),
  );
  return rows;
}

export type FeedbackSeed = {
  profileId: string | null;
  kind?: "rating" | "complaint";
  outletId?: string;
  /** Default: a fresh order attributed to the profile (null profile: QR guest order). */
  orderUlid?: string;
  comment?: string | null;
};

/** An `open` feedback row on a fresh order; returns the feedback id and order ULID. */
export async function seedFeedback(
  seed: FeedbackSeed,
): Promise<{ id: string; orderUlid: string }> {
  const outletId = seed.outletId ?? seededOutletA;
  const kind = seed.kind ?? "rating";
  const orderUlid =
    seed.orderUlid ??
    (await seedOrder(seededTenantId, {
      outletId,
      profileId: seed.profileId,
      channel: seed.profileId === null ? "qr" : "pos",
    }));
  const id = randomUUID();
  await asTenant(seededTenantId, (client) =>
    client.query(
      `INSERT INTO feedback
         (id, tenant_id, outlet_id, customer_profile_id, order_id, kind, rating, comment, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
      [
        id,
        seededTenantId,
        outletId,
        seed.profileId,
        ulidToUuid(orderUlid),
        kind,
        kind === "rating" ? 4 : null,
        seed.comment ?? (kind === "complaint" ? `Keluhan ${id}` : null),
      ],
    ),
  );
  return { id, orderUlid };
}

/** An open table session at a seeded outlet; `userId` joins it as a participant. */
export async function seedTableSession(
  userIds: readonly string[],
  outletId: string = seededOutletA,
): Promise<string> {
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  await asTenant(seededTenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, seededTenantId, outletId, `Zona FB ${sessionId.slice(0, 6)}`],
    );
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{"x":1,"y":1,"width":20,"height":20,"rotation":0,"shape":"rect"}'::jsonb)`,
      [
        tableId,
        seededTenantId,
        outletId,
        zoneId,
        `FB-${sessionId.slice(0, 6)}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
      [
        sessionId,
        seededTenantId,
        outletId,
        tableId,
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    for (const userId of userIds)
      await client.query(
        `INSERT INTO session_participants (tenant_id, outlet_id, table_session_id, device_hash, user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [seededTenantId, outletId, sessionId, `dev-${randomUUID()}`, userId],
      );
  });
  return sessionId;
}
