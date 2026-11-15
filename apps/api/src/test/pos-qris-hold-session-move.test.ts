// QRIS hold vs table-session operations (legend-yhia9, architect round 2, R3).
// Merging two tables or moving order items to another session changes which
// table session a bill belongs to. While a QR is collectible (hold `open` or
// `cancelling`) the bill is frozen like a DP (design D-01): moving it is refused
// with 409 QRIS_HOLD_ACTIVE, nothing moves, and the QR stays payable. Once the
// provider has closed the hold, the same operation works.
//
// Written from the design and the public contract (routes
// POST /api/table-sessions/:id/{merge,move-items}, shared table-operations
// schemas), not from the implementation.
//
// Assumptions:
// - An earlier rule may refuse first with 409 CONFLICT ("Sesi yang sudah dibayar
//   sebagian..."); that is accepted next to QRIS_HOLD_ACTIVE. What the tests
//   prove is that nothing moves and the hold/tender are untouched.
// - A plain table move (`/move`) keeps the order on the same session, so it is
//   not part of this file.
// - Both fixture sessions are pay-first, same outlet, no payment yet, so the
//   only reason a merge or an item move can be refused here is the hold. The
//   "after the hold is closed" control in each test proves that.
// - The error body carries the code at `error.code` (or `code`).
// - Fixture bill: Rp30.000 meal + 10% PBJT = Rp33.000.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import { originHeader } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  postCancel,
  readHold,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  type HoldFixture,
  type IssuedQris,
} from "./pos-qris-hold-test-helpers.ts";

const BILL_IDR = 33_000;

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-session-move");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------- helpers

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body?.error?.code ?? body?.code;

const at = (qr: IssuedQris, seconds: number) =>
  new Date(qr.expiresAt.getTime() + seconds * 1000);

const postSession = (path: string, body: Record<string, unknown>) =>
  fx.staff.client
    .post(`/api/table-sessions/${path}`)
    .set(fx.headers)
    .set(originHeader)
    .send(body);

async function sessionOf(orderId: string) {
  const { rows } = await owner.query<{ sid: string }>(
    `SELECT table_session_id::text AS sid FROM orders
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.sid;
}

async function itemIdsOf(orderId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM order_items
      WHERE tenant_id=$1 AND order_id=$2 ORDER BY id`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.map((row) => uuidToUlid(row.id));
}

async function sessionStatus(sessionId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM table_sessions WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, sessionId],
  );
  return rows[0]!.status;
}

/** Two tables, each with one submitted Rp33.000 bill. */
async function twoTables() {
  const held = await newSubmittedOrder(fx, 0);
  const other = await newSubmittedOrder(fx, 0);
  const heldSession = await sessionOf(held.id);
  const otherSession = await sessionOf(other.id);
  expect(heldSession).not.toBe(otherSession);
  return { held, other, heldSession, otherSession };
}

type Tables = Awaited<ReturnType<typeof twoTables>>;

/** The merge request as staff send it: target session in the path, the
 * session to fold in as `sourceSessionId`. */
const mergeHeldInto = (t: Tables) =>
  postSession(`${t.otherSession}/merge`, { sourceSessionId: t.heldSession });

const moveItemsOfHeld = async (t: Tables) =>
  postSession(`${t.heldSession}/move-items`, {
    toSessionId: t.otherSession,
    orderItemIds: await itemIdsOf(t.held.id),
  });

/** Cashier hides the QR and the provider confirms it is dead. */
async function closeHold(t: Tables, qr: IssuedQris) {
  fx.gateway.script(qr.intentId, { rawStatus: "02" });
  const cancelled = await postCancel(fx, t.held.id);
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
  try {
    await runHoldCheck(fx, at(qr, HOLD_CLOSE_MARGIN_S + 1));
  } catch (error) {
    if (!/scripted/.test(String(error))) throw error;
  }
  expect((await readHold(fx, t.held.id))?.state).toBe("closed");
}

/** Nothing moved: bills stay on their sessions, the QR is still payable. */
async function expectFrozen(
  t: Tables,
  qr: IssuedQris,
  state: "open" | "cancelling",
  response: {
    status: number;
    body: { error?: { code?: string }; code?: string };
  },
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  // The API may refuse earlier ("Sesi yang sudah dibayar sebagian...", code
  // CONFLICT) or at the hold guard (QRIS_HOLD_ACTIVE); either way nothing moves.
  expect(
    ["CONFLICT", "QRIS_HOLD_ACTIVE"],
    JSON.stringify(response.body),
  ).toContain(errorCode(response.body));
  expect(await sessionOf(t.held.id)).toBe(t.heldSession);
  expect(await sessionOf(t.other.id)).toBe(t.otherSession);
  expect(await sessionStatus(t.heldSession)).toBe("open");
  expect((await readHold(fx, t.held.id))?.state).toBe(state);
  expect(await tenderStatuses(fx, t.held.id)).toEqual([
    expect.objectContaining({ status: "authorized", amount: qr.amountIdr }),
  ]);
}

// --------------------------------------------------------------------- tests

describe("QRIS hold: a bill with a collectible QR cannot be moved to another table session", () => {
  it("SESSION-MOVE-01 merge: the table with an open QR cannot be folded into another table", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    expect(qr.amountIdr).toBe(BILL_IDR);

    await expectFrozen(t, qr, "open", await mergeHeldInto(t));
  });

  it("SESSION-MOVE-02 merge: still refused while the cashier-hidden QR is cancelling", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    const cancelled = await postCancel(fx, t.held.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    await expectFrozen(t, qr, "cancelling", await mergeHeldInto(t));
  });

  it("SESSION-MOVE-03 merge: allowed once the provider has closed the hold (the refusal was about the QR)", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    expect((await mergeHeldInto(t)).status).toBe(409);

    await closeHold(t, qr);
    const merged = await mergeHeldInto(t);

    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(await sessionOf(t.held.id)).toBe(t.otherSession);
  });

  it("SESSION-MOVE-04 move-items: moving the items of a bill with an open QR to another table is refused", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    const itemsBefore = await itemIdsOf(t.held.id);

    await expectFrozen(t, qr, "open", await moveItemsOfHeld(t));
    expect(await itemIdsOf(t.held.id)).toEqual(itemsBefore);
  });

  it("SESSION-MOVE-05 move-items: still refused while the QR is cancelling", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    const cancelled = await postCancel(fx, t.held.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    await expectFrozen(t, qr, "cancelling", await moveItemsOfHeld(t));
  });

  it("SESSION-MOVE-06 move-items: allowed once the provider has closed the hold (the refusal was about the QR)", async () => {
    const t = await twoTables();
    const qr = await issueQris(fx, t.held.id);
    expect((await moveItemsOfHeld(t)).status).toBe(409);

    await closeHold(t, qr);
    const moved = await moveItemsOfHeld(t);

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  });

  it("SESSION-MOVE-07 a bill without a QR is not affected: merge of two free tables works", async () => {
    const t = await twoTables();
    const merged = await mergeHeldInto(t);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(await sessionOf(t.held.id)).toBe(t.otherSession);
  });
});
