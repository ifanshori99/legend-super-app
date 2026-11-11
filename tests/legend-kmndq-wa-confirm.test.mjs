// WhatsApp login confirm card (bead kmndq, customer web /masuk). After the
// guest's message lands, the browser shows the masked sender and waits for
// "Ya, masuk" (confirm) or "Bukan saya" (cancel) before a session exists.
// Contract (packages/shared/src/identity): create body `requireConfirm`, poll
// view `awaitingConfirmation` + `senderMasked`, POST .../:id/confirm and
// POST .../:id/cancel. Loaded with plain Node ESM like the other suites.
//
// ASSUMPTIONS (the spec only names the behaviour, not the code surface):
//  - flow.ts `loginChallengeOutcome` gains a fifth outcome
//    "awaiting_confirmation": awaitingConfirmation, session null, status
//    pending or completed, unexpired.
//  - An awaiting challenge has the REAL API shape (identity-login.service
//    :586-599): challenge.status "completed", session null,
//    awaitingConfirmation true. Confirm is idempotent; before the message
//    lands (status pending) it throws CHALLENGE_NOT_PENDING.
//  - The FE mock (handlers/login-challenge.ts) with requireConfirm:true answers
//    the first poll "pending" and the second poll awaiting with
//    senderMasked "+62 812-****-7890"; confirm lets the NEXT poll hand out
//    the session once; cancel ends it as "cancelled".
//  - The client sends `requireConfirm: true` from ws01-login/api.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import {
  cafeLegendIdentityFixtures as fx,
  loginChallengeSchema,
  loginChallengeViewSchema,
} from "../packages/shared/src/identity/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws01-login/mock.ts";
import {
  LOGIN_OUTCOMES,
  loginChallengeOutcome,
} from "../apps/web/src/features/ws01-login/flow.ts";

const MINUTE_MS = 60_000;
const MASKED = "+62 812-****-7890";

function awaitingViewAt(at, overrides = {}) {
  const challenge = loginChallengeSchema.parse({
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    brandId: fx.brandId,
    channel: "whatsapp_inbound",
    status: "completed",
    expiresAt: new Date(at + 5 * MINUTE_MS).toISOString(),
    completedAt: new Date(at).toISOString(),
    matchedUserId: fx.usersByKey.sari.id,
    createdAt: new Date(at).toISOString(),
    ...overrides.challenge,
  });
  return loginChallengeViewSchema.parse({
    challenge,
    session: null,
    mfaRequired: false,
    mfaEnrollmentRequired: false,
    senderMasked: MASKED,
    awaitingConfirmation: true,
    ...overrides.view,
  });
}

const request = (method, path, body) =>
  dispatchMock({ method, path, body });
const issue = async (body) =>
  (await request("POST", "/api/auth/login-challenges/whatsapp", body)).data;
const poll = async (id) =>
  (await request("GET", `/api/auth/login-challenges/${id}`)).data;
const confirm = (id) =>
  request("POST", `/api/auth/login-challenges/${id}/confirm`);
const cancel = (id) =>
  request("POST", `/api/auth/login-challenges/${id}/cancel`);

describe("kmndq: challenge outcome while awaiting confirmation", () => {
  test("kmndq: the outcome list names the awaiting state", () => {
    assert.ok(LOGIN_OUTCOMES.includes("awaiting_confirmation"));
  });

  test("kmndq: a landed message that is not confirmed yet reads awaiting_confirmation", () => {
    const at = Date.parse("2026-11-11T09:00:00Z");
    assert.equal(
      loginChallengeOutcome(awaitingViewAt(at), at + MINUTE_MS),
      "awaiting_confirmation",
    );
  });

  test("kmndq: the old pending-shaped awaiting view still reads awaiting_confirmation", () => {
    const at = Date.parse("2026-11-11T09:00:00Z");
    const view = awaitingViewAt(at, {
      challenge: { status: "pending", completedAt: null, matchedUserId: null },
    });
    assert.equal(
      loginChallengeOutcome(view, at + MINUTE_MS),
      "awaiting_confirmation",
    );
  });

  test("kmndq: completed + no session + awaitingConfirmation reads awaiting_confirmation, not expired", () => {
    // The old flow.ts returned "expired" for any completed view without a
    // session (the first completed-branch line), so this fails there.
    const at = Date.parse("2026-11-11T09:00:00Z");
    const view = awaitingViewAt(at);
    assert.equal(view.challenge.status, "completed");
    assert.equal(view.session, null);
    assert.equal(
      loginChallengeOutcome(view, at + MINUTE_MS),
      "awaiting_confirmation",
    );
  });

  test("kmndq: an awaiting challenge past its 5 minutes reads expired", () => {
    const at = Date.parse("2026-11-11T09:00:00Z");
    assert.equal(
      loginChallengeOutcome(awaitingViewAt(at), at + 5 * MINUTE_MS),
      "expired",
    );
  });

  test("kmndq: an awaiting challenge cancelled elsewhere reads cancelled", () => {
    const at = Date.parse("2026-11-11T09:00:00Z");
    const view = awaitingViewAt(at, {
      challenge: { status: "cancelled", completedAt: null, matchedUserId: null },
      view: { awaitingConfirmation: false, senderMasked: undefined },
    });
    assert.equal(loginChallengeOutcome(view, at + MINUTE_MS), "cancelled");
  });

  test("kmndq: without the awaiting flag a pending challenge stays pending", () => {
    const at = Date.parse("2026-11-11T09:00:00Z");
    const view = awaitingViewAt(at, {
      challenge: { status: "pending", completedAt: null, matchedUserId: null },
      view: { awaitingConfirmation: false, senderMasked: undefined },
    });
    assert.equal(loginChallengeOutcome(view, at + MINUTE_MS), "pending");
  });
});

describe("kmndq: mock challenge with requireConfirm", () => {
  beforeEach(() => resetMocks());

  test("kmndq: the message lands -> awaiting with the masked sender and no session", async () => {
    const issued = await issue({ requireConfirm: true });
    const first = await poll(issued.challenge.id);
    assert.equal(first.challenge.status, "pending");
    assert.notEqual(first.awaitingConfirmation, true);

    const second = await poll(issued.challenge.id);
    assert.equal(second.awaitingConfirmation, true);
    assert.equal(second.senderMasked, MASKED);
    assert.equal(second.challenge.status, "completed");
    assert.equal(second.session, null, "no session before the person confirms");

    const third = await poll(issued.challenge.id);
    assert.equal(third.awaitingConfirmation, true, "still waiting for a tap");
    assert.equal(third.session, null);
  });

  test("kmndq: confirm completes the challenge and hands the session out once", async () => {
    const issued = await issue({ requireConfirm: true });
    await poll(issued.challenge.id);
    await poll(issued.challenge.id);

    await confirm(issued.challenge.id);

    const done = await poll(issued.challenge.id);
    assert.equal(done.challenge.status, "completed");
    assert.ok(done.session, "the confirming browser gets its session");
    assert.equal(done.session.kind, "customer");
    assert.notEqual(done.awaitingConfirmation, true);

    const again = await poll(issued.challenge.id);
    assert.equal(again.session, null, "single use (AUTH-01)");
  });

  test("kmndq: Bukan saya cancels an awaiting challenge and no session appears", async () => {
    const issued = await issue({ requireConfirm: true });
    await poll(issued.challenge.id);
    await poll(issued.challenge.id);

    await cancel(issued.challenge.id);

    const view = await poll(issued.challenge.id);
    assert.equal(view.challenge.status, "cancelled");
    assert.equal(view.session, null);
    assert.notEqual(view.awaitingConfirmation, true);
  });

  test("kmndq: a double confirm is idempotent and still hands the session out once", async () => {
    const issued = await issue({ requireConfirm: true });
    await poll(issued.challenge.id);
    await poll(issued.challenge.id);

    await confirm(issued.challenge.id);
    await confirm(issued.challenge.id);

    const done = await poll(issued.challenge.id);
    assert.ok(done.session, "session after the confirm");
    await confirm(issued.challenge.id);
    const again = await poll(issued.challenge.id);
    assert.equal(again.session, null, "single use (AUTH-01)");
  });

  test("kmndq: confirm before the message lands is CHALLENGE_NOT_PENDING", async () => {
    const issued = await issue({ requireConfirm: true });
    await assert.rejects(confirm(issued.challenge.id), (error) => {
      assert.equal(error.code, "CHALLENGE_NOT_PENDING");
      return true;
    });
    // One poll in the message still has not landed.
    await poll(issued.challenge.id);
    await assert.rejects(confirm(issued.challenge.id), (error) => {
      assert.equal(error.code, "CHALLENGE_NOT_PENDING");
      return true;
    });
  });

  test("kmndq: a cancelled challenge can no longer be confirmed", async () => {
    const issued = await issue({ requireConfirm: true });
    await poll(issued.challenge.id);
    await poll(issued.challenge.id);
    await cancel(issued.challenge.id);

    await assert.rejects(confirm(issued.challenge.id), (error) => {
      assert.equal(error.code, "CHALLENGE_NOT_PENDING");
      return true;
    });
  });

  test("kmndq: without requireConfirm the old flow still signs in on the second poll", async () => {
    const issued = await issue({});
    await poll(issued.challenge.id);
    const second = await poll(issued.challenge.id);
    assert.equal(second.challenge.status, "completed");
    assert.ok(second.session);
    assert.notEqual(second.awaitingConfirmation, true);
  });
});

describe("kmndq: the client asks for confirmation", () => {
  test("kmndq: startWhatsAppLogin creates the challenge with requireConfirm true", () => {
    // The screens call api.ts through hooks, and api.ts needs the Vite alias,
    // so this suite reads the source like consent-sources.test.mjs does.
    const source = readFileSync(
      new URL(
        "../apps/web/src/features/ws01-login/api.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const start = source.slice(source.indexOf("startWhatsAppLogin"));
    const body = start.slice(0, start.indexOf("\n}\n"));
    assert.match(body, /requireConfirm:\s*true/);
  });
});
