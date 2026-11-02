// Customer and staff sign-in (WS-01, bead legend-baa): the rules behind
// /masuk, /masuk/email, /masuk/google, /masuk/tautan and /masuk/hubungkan, and
// the mock handlers those screens run against. Loaded with plain Node ESM and
// built-in type stripping like the other suites.
//
// Covers PRD v1.7 §3 F3 "Autentikasi & Identitas", §4 Alur C, and the
// acceptance criteria the bead names: AUTH-01 (code entropy/lifetime/single
// use/browser binding), AUTH-03 (no WhatsApp message is sent by the system) and
// AUTH-07 (points need a verified WhatsApp number).
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  cafeLegendIdentityFixtures as fx,
  formatLoginCode,
  googleLoginStartSchema,
  loginChallengeSchema,
  loginChallengeViewSchema,
  LOGIN_CODE_PATTERN,
  returnPathSchema,
  WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT,
} from "../packages/shared/src/identity/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws01-login/mock.ts";
import {
  challengeFailure,
  formatRemaining,
  loginChallengeOutcome,
  loginCodeRemainingMs,
  loginErrorKey,
  postLoginPath,
  safeReturnPath,
  signInPath,
} from "../apps/web/src/features/ws01-login/flow.ts";

const MINUTE_MS = 60_000;

function iso(at) {
  return new Date(at).toISOString();
}

/** A challenge view at `at`, pending unless overridden. */
function viewAt(at, overrides = {}) {
  const challenge = loginChallengeSchema.parse({
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    brandId: fx.brandId,
    channel: "whatsapp_inbound",
    status: "pending",
    expiresAt: iso(at + 5 * MINUTE_MS),
    completedAt: null,
    matchedUserId: null,
    createdAt: iso(at),
    ...overrides.challenge,
  });
  return loginChallengeViewSchema.parse({
    challenge,
    session: overrides.session ?? null,
    mfaRequired: false,
    mfaEnrollmentRequired: false,
  });
}

async function request(method, path, { query, body } = {}) {
  return dispatchMock({ method, path, query, body });
}

async function issueChallenge() {
  const { data } = await request(
    "POST",
    "/api/auth/login-challenges/whatsapp",
    { body: {} },
  );
  return data;
}

async function poll(challengeId) {
  const { data } = await request(
    "GET",
    `/api/auth/login-challenges/${encodeURIComponent(challengeId)}`,
  );
  return data;
}

describe("WhatsApp challenge states (AUTH-01)", () => {
  test("AUTH-01: a pending code expires five minutes after it was issued", () => {
    const at = Date.parse("2026-11-02T02:00:00.000Z");
    const view = viewAt(at);

    assert.equal(loginChallengeOutcome(view, at), "pending");
    assert.equal(loginCodeRemainingMs(view.challenge, at), 5 * MINUTE_MS);
    assert.equal(
      loginChallengeOutcome(view, at + 5 * MINUTE_MS),
      "expired",
      "the local clock expires a code the server has not swept yet",
    );
    assert.equal(loginCodeRemainingMs(view.challenge, at + 6 * MINUTE_MS), 0);
  });

  test("AUTH-01: a completed code without a session here reads expired, not signed in", () => {
    const at = Date.parse("2026-11-02T02:00:00.000Z");
    const spent = viewAt(at, {
      challenge: {
        status: "completed",
        completedAt: iso(at),
        matchedUserId: fx.usersByKey.sari.id,
      },
    });
    // The second poll after the session was claimed carries no session.
    assert.equal(loginChallengeOutcome(spent, at), "expired");

    const handedOut = viewAt(at, {
      challenge: {
        status: "completed",
        completedAt: iso(at),
        matchedUserId: fx.usersByKey.sari.id,
      },
      session: fx.sessions.find((session) => session.kind === "customer"),
    });
    assert.equal(loginChallengeOutcome(handedOut, at), "signed_in");
  });

  test("AUTH-01: a cancelled challenge reads cancelled", () => {
    const at = Date.parse("2026-11-02T02:00:00.000Z");
    const view = viewAt(at, { challenge: { status: "cancelled" } });
    assert.equal(loginChallengeOutcome(view, at), "cancelled");
  });

  test("AUTH-01: the countdown keeps minutes and seconds", () => {
    assert.equal(formatRemaining(298_000), "4:58");
    assert.equal(formatRemaining(5 * MINUTE_MS), "5:00");
    assert.equal(formatRemaining(0), "0:00");
    assert.equal(formatRemaining(-1), "0:00");
  });

  test("AUTH-01: every failure that ends a code asks for a new one", () => {
    assert.equal(challengeFailure({ code: "CHALLENGE_EXPIRED" }), "expired");
    assert.equal(
      challengeFailure({ code: "CHALLENGE_BROWSER_MISMATCH" }),
      "mismatch",
      "the code was asked for in another browser",
    );
    assert.equal(challengeFailure({ code: "CHALLENGE_NOT_PENDING" }), "used");
    assert.equal(challengeFailure({ code: "RATE_LIMITED" }), "rateLimited");
    assert.equal(
      challengeFailure({ code: "IDENTITY_ALREADY_LINKED" }),
      "alreadyLinked",
    );
    // A network problem does not spend the code; it only fails one poll.
    assert.equal(challengeFailure({ code: "NETWORK_ERROR" }), null);
    assert.equal(challengeFailure(new Error("boom")), null);
  });

  test("AUTH-01: failures that are not end states keep a fix hint", () => {
    assert.equal(
      loginErrorKey({ code: "NETWORK_ERROR" }),
      "login.errors.offline",
    );
    assert.equal(
      loginErrorKey({ code: "RATE_LIMITED" }),
      "login.errors.tooMany",
    );
    assert.equal(
      loginErrorKey({ code: "VALIDATION_ERROR" }),
      "login.errors.invalidEmail",
    );
    assert.equal(loginErrorKey(new Error("boom")), "login.errors.generic");
  });

  test("AUTH-01: server-built navigation URLs are https only (no javascript:)", () => {
    // The screens put these straight into an href / location.assign.
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://wa.me/1",
    ]) {
      assert.equal(
        googleLoginStartSchema.safeParse({ authorizationUrl: bad }).success,
        false,
        bad,
      );
    }
    assert.equal(
      googleLoginStartSchema.safeParse({
        authorizationUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?state=x",
      }).success,
      true,
    );
  });

  test("AUTH-01: the return path stays on this app (open redirect is refused)", () => {
    for (const value of ["/member", "/t/abc/bill", "/", "/masuk?lanjut=/x"]) {
      assert.equal(safeReturnPath(value), value);
      assert.equal(returnPathSchema.safeParse(value).success, true);
    }
    for (const value of [
      "//evil.example",
      "https://evil.example",
      "/" + "a".repeat(300),
    ]) {
      assert.equal(safeReturnPath(value), undefined, value);
      assert.equal(returnPathSchema.safeParse(value).success, false, value);
    }
    // Browsers normalize "\" to "/" and drop tab/CR/LF inside URLs, so each of
    // these becomes a protocol-relative "//evil.example". The contract the
    // /masuk routes validate `?lanjut=` with must refuse them (Opus review,
    // legend-baa), not only the screen helper.
    for (const value of [
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/ /evil.example",
    ]) {
      assert.equal(safeReturnPath(value), undefined, JSON.stringify(value));
      assert.equal(
        returnPathSchema.safeParse(value).success,
        false,
        JSON.stringify(value),
      );
    }
    assert.equal(safeReturnPath(undefined), undefined);
    assert.equal(safeReturnPath(""), undefined);
    assert.equal(signInPath("/member"), "/masuk?lanjut=%2Fmember");
    assert.equal(signInPath("https://evil.example"), "/masuk");
  });

  test("AUTH-01: a completed sign-in lands on the surface its session belongs to", () => {
    assert.equal(postLoginPath({ kind: "customer" }), "/member");
    assert.equal(postLoginPath({ kind: "management" }), "/kelola");
  });
});

describe("mock challenge through the typed runtime (AUTH-01, AUTH-03)", () => {
  beforeEach(() => resetMocks());

  test("AUTH-01: the issued code carries the example format, 5-minute window and a deep link", async () => {
    const issued = await issueChallenge();

    assert.match(issued.code, LOGIN_CODE_PATTERN);
    assert.equal(issued.codeFormatted, formatLoginCode(issued.code));
    assert.match(issued.codeFormatted, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(issued.challenge.status, "pending");
    assert.equal(
      Date.parse(issued.challenge.expiresAt) -
        Date.parse(issued.challenge.createdAt),
      5 * MINUTE_MS,
    );
  });

  test("AUTH-01: the browser that asked gets the session once; a second poll finds it spent", async () => {
    const issued = await issueChallenge();

    const first = await poll(issued.challenge.id);
    assert.equal(first.challenge.status, "pending");
    assert.equal(first.session, null);

    const second = await poll(issued.challenge.id);
    assert.equal(second.challenge.status, "completed");
    assert.ok(second.session, "the sending browser gets its session");
    assert.equal(second.session.kind, "customer");

    const third = await poll(issued.challenge.id);
    assert.equal(third.challenge.status, "completed");
    assert.equal(third.session, null, "the code is single use (AUTH-01)");
  });

  test("AUTH-03: the guest sends the message — the app only opens a filled-in wa.me link", async () => {
    const issued = await issueChallenge();
    const link = new URL(issued.whatsAppDeepLink);

    assert.equal(link.origin, "https://wa.me");
    assert.equal(link.pathname, `/${fx.login.number}`);
    assert.equal(
      link.searchParams.get("text"),
      `${fx.login.keyword} ${issued.codeFormatted}`,
    );
    // The issued payload has no message/reply field: nothing is sent to the
    // guest (AUTH-03, PRD "Sistem tidak membalas di WhatsApp secara default").
    assert.deepEqual(Object.keys(issued).sort(), [
      "challenge",
      "code",
      "codeFormatted",
      "whatsAppDeepLink",
    ]);
    assert.equal(WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT, false);
  });
});

describe("email link, Google and the identity view", () => {
  beforeEach(() => resetMocks());

  test("AUTH-03/AUTH-01: the email answer is identical for every address", async () => {
    const known = await request("POST", "/api/auth/login-challenges/email", {
      body: { email: "sari.puspita@gmail.com" },
    });
    const unknown = await request("POST", "/api/auth/login-challenges/email", {
      body: { email: "nobody@example.com" },
    });

    assert.deepEqual(Object.keys(known.data).sort(), ["expiresAt", "sent"]);
    assert.equal(known.data.sent, true);
    assert.equal(
      Date.parse(known.data.expiresAt) - Date.now() <= 15 * MINUTE_MS,
      true,
      "the link window is 15 minutes",
    );
    // No account-enumeration field: the two answers differ only in the clock.
    assert.deepEqual(
      Object.keys(known.data).sort(),
      Object.keys(unknown.data).sort(),
    );
  });

  test("AUTH-01: the clicked email link sets a customer session", async () => {
    const token = "a".repeat(43);
    const { data } = await request("GET", "/api/auth/magic-link", {
      query: { token },
    });
    assert.equal(data.session.kind, "customer");
    assert.equal(data.mfaRequired, false);
  });

  test("AUTH-07: an unverified account has no points; linking the number verifies it", async () => {
    const before = await request("GET", "/api/auth/me");
    assert.equal(before.data.whatsAppVerified, false);

    const issued = await issueChallenge();
    await poll(issued.challenge.id);
    const completed = await poll(issued.challenge.id);
    assert.ok(completed.session);

    const after = await request("GET", "/api/auth/me");
    assert.equal(after.data.whatsAppVerified, true);
    assert.equal(after.data.session.kind, "customer");
  });

  test("Google start answers a provider URL with a browser-bound state", async () => {
    const { data } = await request("GET", "/api/auth/google/start");
    const url = new URL(data.authorizationUrl);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok((url.searchParams.get("state") ?? "").length >= 16);
  });
});
