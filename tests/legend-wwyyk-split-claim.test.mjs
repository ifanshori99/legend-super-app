// legend-wwyyk: claim of one paid split part through the mock API
// (POST /api/table-sessions/:sessionId/splits/:splitId/claim).
// Contract: packages/shared/src/qr-order/guest.ts `getSplitClaim` +
// `splitClaimSchema`. The claim ALWAYS answers 200 with the status in the body;
// the first claim of a paid part gets a token, a second claim of the same part
// is `claimed` WITHOUT a token, a wrong / unknown payer secret is the same 404.
// Money safety: nobody can take the claim of a part someone else paid.
//
// ASSUMPTIONS (spec silent):
//  - A part whose payment is still pending, claimed with the secret it was
//    paid with, is `unavailable` (no token) rather than a 404.
//  - 24 hours after the part is paid the claim reads `expired` (no token).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as sample from "../packages/shared/src/qr-order/sample.ts";
import { registerWebAlias } from "./helpers/web-alias.mjs";

// The QR mock imports through the web `@/` alias: register it first.
registerWebAlias();
const { dispatchMock, resetMocks } =
  await import("../apps/web/src/lib/mock/runtime.ts");
await import("../apps/web/src/features/ws03-qr-order/mock.ts");

const T = sample.qrTokenFixtures;
const START = 1_700_000_000_000;
const HOUR = 3_600_000;
const secret = () => `ps_${randomBytes(32).toString("base64url")}`;
const key = () => `claim-${Math.random().toString(36).slice(2)}-abcdef`;
const request = (method, path, body) => dispatchMock({ method, path, body });

async function openPrivateRoom() {
  const scan = (
    await request("POST", "/api/qr/sessions", {
      qrToken: T.privateRoom,
      pax: 3,
      deviceHash: "d".repeat(32),
    })
  ).data;
  const sessionId = scan.session.id;
  const bill = (await request("GET", `/api/table-sessions/${sessionId}/bill`))
    .data;
  return {
    sessionId,
    pending: bill.splits.filter((s) => s.status === "pending"),
  };
}

const pay = (sessionId, splitId, payerSecret) =>
  request("POST", `/api/table-sessions/${sessionId}/payments`, {
    target: { kind: "split", billSplitId: splitId },
    method: "qris",
    payerSecret,
    idempotencyKey: key(),
  });
const claim = async (sessionId, splitId, payerSecret) =>
  (
    await request(
      "POST",
      `/api/table-sessions/${sessionId}/splits/${splitId}/claim`,
      { payerSecret },
    )
  ).data;
const settle = () => mock.timers.tick(10_000);

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: START });
  resetMocks();
});
afterEach(() => {
  mock.timers.reset();
});

describe("split part claim mock (legend-wwyyk)", () => {
  test("a paid part gives its payer a claim token valid for 24 hours", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    assert.ok(pending.length >= 1);
    const mine = secret();
    await pay(sessionId, pending[0].id, mine);
    settle();
    const result = await claim(sessionId, pending[0].id, mine);
    qr.splitClaimSchema.parse(result);
    assert.equal(result.status, "available");
    assert.equal(result.billSplitId, pending[0].id);
    assert.ok(result.claimToken && result.claimToken.length > 0);
    const until = Date.parse(result.claimableUntil);
    assert.ok(
      until > Date.now() + 23 * HOUR && until <= Date.now() + 25 * HOUR,
    );
  });

  test("a part still waiting for payment is unavailable and carries no token", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    const mine = secret();
    await pay(sessionId, pending[0].id, mine);
    const result = await claim(sessionId, pending[0].id, mine);
    assert.equal(result.status, "unavailable");
    assert.equal(result.claimToken, null);
  });

  test("the same part claimed a second time is `claimed` without a token", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    const mine = secret();
    await pay(sessionId, pending[0].id, mine);
    settle();
    const first = await claim(sessionId, pending[0].id, mine);
    assert.equal(first.status, "available");
    const second = await claim(sessionId, pending[0].id, mine);
    qr.splitClaimSchema.parse(second);
    assert.equal(second.status, "claimed");
    assert.equal(second.claimToken, null);
  });

  test("a wrong or unknown payer secret is a 404 and never leaks the token", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    const mine = secret();
    await pay(sessionId, pending[0].id, mine);
    settle();
    await assert.rejects(
      claim(sessionId, pending[0].id, secret()),
      (error) => error.status === 404,
    );
    // The failed guess does not burn the real payer's claim.
    const real = await claim(sessionId, pending[0].id, mine);
    assert.equal(real.status, "available");
    assert.ok(real.claimToken);
  });

  test("the secret of one part cannot claim another part", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    if (pending.length < 2) return; // the private-room fixture seeds two open parts
    const [a, b] = pending;
    const secretA = secret();
    const secretB = secret();
    await pay(sessionId, a.id, secretA);
    await pay(sessionId, b.id, secretB);
    settle();
    await assert.rejects(
      claim(sessionId, b.id, secretA),
      (error) => error.status === 404,
    );
    await assert.rejects(
      claim(sessionId, a.id, secretB),
      (error) => error.status === 404,
    );
    assert.equal((await claim(sessionId, a.id, secretA)).status, "available");
    assert.equal((await claim(sessionId, b.id, secretB)).status, "available");
  });

  test("a part that does not exist or never had a payer is a 404", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    await assert.rejects(
      claim(sessionId, pending[0].id, secret()),
      (error) => error.status === 404,
    );
    await assert.rejects(
      claim(sessionId, "00000000-0000-4000-8000-00000000ffff", secret()),
      (error) => error.status === 404,
    );
  });

  test("a malformed payer secret is refused before the claim runs", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    await assert.rejects(
      claim(sessionId, pending[0].id, "not-a-secret"),
      (error) => error.status === 400 || error.status === 422,
    );
  });

  test("the claim reads `expired` without a token once 24 hours have passed", async () => {
    const { sessionId, pending } = await openPrivateRoom();
    const mine = secret();
    await pay(sessionId, pending[0].id, mine);
    settle();
    mock.timers.tick(25 * HOUR);
    const result = await claim(sessionId, pending[0].id, mine);
    qr.splitClaimSchema.parse(result);
    // Shared contract: the claim window is 24 h after the part is paid.
    assert.equal(result.status, "expired");
    assert.equal(result.claimToken, null);
  });
});
