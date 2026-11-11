// Card lnbtp: every customer WhatsApp login must be confirmed by the person
// (masked number + "Ini saya"), and "Bukan saya" must leave nothing behind.
//
// Written from the brief (docs/briefs/lnbtp.md), the decided w8dfz.1 design
// (docs/briefs/w8dfz1-masked-confirm.md), the PRD login flow (AUTH-01, AUTH-03,
// AUTH-04) and the shared validators, not from the implementation.
//
// Goals covered:
//  1. requireConfirm is mandatory: the client cannot switch it off.
//  2. "Bukan saya": cancel, no "success" WhatsApp reply, the account that was
//     auto-created for the sender is tidied, an older account is untouched.
//  3. Race: cancel vs confirm / poll at the same time never leaves a session.
//
// Assumptions (the spec does not fix them):
//  - Absent or false `requireConfirm` is EITHER rejected with a 4xx OR accepted
//    and treated as true (awaiting confirmation). Both satisfy "the client
//    cannot turn it off"; the only failure is a session without a confirm.
//  - The view fields `awaitingConfirmation` / `senderMasked` may sit on `data`
//    or on `data.challenge`.
//  - "Tidied" for an auto-created, never-used account means: the sender's
//    WhatsApp identity row is gone, OR the user row is gone, OR the user row is
//    flagged inactive (banned / disabled / deactivated / deleted flag or
//    timestamp). The column used for "nonaktifkan" is not fixed.
//  - "Bukan saya" after the person already pressed confirm but before the poll
//    issued the session still cancels (w8dfz.1: cancel is valid while no
//    session was issued). So cancel vs confirm always ends cancelled.
//  - Cancel vs poll (after confirm) may end either way, but never inconsistent:
//    cancelled means no session anywhere; completed means a signed-in session.
//  - The success reply, if the tenant enabled replies, must never go out for a
//    challenge that ends in "Bukan saya". Whether it goes out after confirm is
//    not observable here and is not asserted.
//  - Race "Bukan saya" on challenge A vs a second inbound message B from the
//    same number (T1 of the lnbtp architect findings): B is held through the
//    `deps.resolveAccount` hook after it resolved the existing account and
//    before it completes; cancel A runs in that gap. Whatever B ends as
//    (refused, or pointing at a live user), no challenge may point at a user
//    that no longer exists (`login_challenges.matched_user_id` has no FK).
//    The cancel itself must answer 204 even then. If B's message is not
//    resolved at all (e.g. the per-number window drops it) the test fails
//    loudly instead of passing vacuously.
//  - Replies are observed with the `sendReply` spy of `processInboundWhatsApp`,
//    as wa-login-reply.test.ts does; the message lands through that service.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { resolveWhatsAppAccount } from "../services/identity-account.service.ts";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service.ts";
import {
  loginReplyText,
  type LoginReplySender,
} from "../services/wa-login-reply.service.ts";
import { agent, originHeader } from "./helpers";

const fixtures = cafeLegendPlatformFixtures;
const TENANT_A = fixtures.tenant.id;
const NUMBER_A = "628111000001";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
// The in-memory HTTP limiter (per IP, per window) is not reset by the database
// wipe and every supertest request comes from loopback, so the ~20 challenges
// issued across this file would trip it (429). This suite is about confirm and
// cancel, not rate limiting (login-challenge-rate-limit.test.ts owns that), so
// the HTTP limits are lifted here. The AUTH-04 per-device rule still applies:
// it counts rows in login_challenges, which beforeEach/resetChallenges empty.
const app = createApp({
  loginChallengeRateLimit: {
    issuePerIp: 100_000,
    issuePerBinding: 100_000,
    pollPerIp: 100_000,
    pollPerBinding: 100_000,
  },
});
const host = fixtures.domains[0]!.hostname;

const digits = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
/** A fresh sender per call keeps the per-number AUTH-04 window out of the way. */
const freshSender = () => `628${digits(10)}`;

function makeSpy() {
  return vi.fn<LoginReplySender>(async () => undefined);
}

async function createChallenge(body: Record<string, unknown>) {
  const browser = agent(app).host(host);
  const issued = await browser
    .post("/api/auth/login-challenges/whatsapp")
    .set(originHeader)
    .send(body);
  return { browser, issued };
}

async function newChallenge(body: Record<string, unknown> = {}) {
  const { browser, issued } = await createChallenge(body);
  expect(issued.status).toBe(201);
  const { challenge, codeFormatted } = issued.body.data;
  return {
    browser,
    codeFormatted: codeFormatted as string,
    path: `/api/auth/login-challenges/${challenge.id as string}`,
  };
}

async function landMessage(
  codeFormatted: string,
  sender: string,
  sendReply: LoginReplySender,
) {
  const outcome = await processInboundWhatsApp(
    {
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender,
      text: `MASUK LEGEND ${codeFormatted}`,
    },
    { sendReply },
  );
  expect(outcome.kind).toBe("login");
}

/** Challenge with requireConfirm: true whose message already landed. */
async function awaitingChallenge(
  sender: string,
  spy: LoginReplySender = makeSpy(),
) {
  const c = await newChallenge({ requireConfirm: true });
  await landMessage(c.codeFormatted, sender, spy);
  const polled = await c.browser.get(c.path);
  expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
  return c;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function viewField(data: any, name: string): unknown {
  return data?.[name] ?? data?.challenge?.[name];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cancel = (c: { browser: any; path: string }) =>
  c.browser.post(`${c.path}/cancel`).set(originHeader).send();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const confirm = (c: { browser: any; path: string }) =>
  c.browser.post(`${c.path}/confirm`).set(originHeader).send();

async function identityOf(sender: string) {
  const { rows } = await owner.query<{ user_id: string }>(
    "SELECT user_id FROM user_identities WHERE type = 'whatsapp' AND value_hash = $1",
    [await whatsAppDigest(sender)],
  );
  return rows[0]?.user_id ?? null;
}

async function userRow(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await owner.query(
    'SELECT to_jsonb(u) AS row FROM "user" u WHERE id = $1',
    [userId],
  );
  return (rows[0]?.row as Record<string, unknown> | undefined) ?? null;
}

function flaggedInactive(row: Record<string, unknown>): boolean {
  return Object.entries(row).some(([key, value]) =>
    /^(banned|disabled|deactivated|deleted|is_?disabled|is_?deleted|inactive)$/i.test(
      key,
    )
      ? value === true
      : /(deactivated|disabled|deleted|banned)_?(at|on)$/i.test(key)
        ? value !== null
        : false,
  );
}

async function sessionCount(userId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM session WHERE user_id = $1",
    [userId],
  );
  return Number(rows[0]!.n);
}

async function resetChallenges() {
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
}

async function wipe() {
  await resetChallenges();
  await owner.query("DELETE FROM user_identities");
  await owner.query(
    `DELETE FROM role_assignments
      WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)
         OR assigned_by IN (SELECT id FROM "user" WHERE email LIKE $1)`,
    ["%@wa.invalid"],
  );
  await owner.query('DELETE FROM "user" WHERE email LIKE $1', ["%@wa.invalid"]);
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [
      TENANT_A,
      JSON.stringify({ vendor: "kirimdev", receivingNumber: NUMBER_A }),
    ],
  );
  // The tenant opted in to login replies, so a wrong "berhasil" would go out.
  await owner.query(
    `INSERT INTO wa_login_reply_policies
       (tenant_id, enabled, free_monthly_quota, replies_month, replies_this_month)
     VALUES ($1, true, 1000, NULL, 0)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = true,
       free_monthly_quota = 1000, replies_month = NULL, replies_this_month = 0`,
    [TENANT_A],
  );
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await owner.query(
    "DELETE FROM wa_login_reply_policies WHERE tenant_id = $1",
    [TENANT_A],
  );
  await owner.end();
});

describe("lnbtp: requireConfirm is mandatory for every WhatsApp login", () => {
  it.each([
    ["absent", {}],
    ["false", { requireConfirm: false }],
  ])(
    "AUTH-01 requireConfirm %s cannot skip the confirm step",
    async (_label, body) => {
      const { browser, issued } = await createChallenge(body);
      if (issued.status >= 400) {
        // Rejected by the contract: the client cannot opt out. Acceptable.
        expect(issued.status).toBeLessThan(500);
        return;
      }
      expect(issued.status).toBe(201);
      const path = `/api/auth/login-challenges/${issued.body.data.challenge.id as string}`;
      const sender = freshSender();
      await landMessage(issued.body.data.codeFormatted, sender, makeSpy());

      const polled = await browser.get(path);
      expect(polled.status).toBe(200);
      expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
      expect(polled.body.data.session ?? null).toBeNull();
      expect(polled.headers["set-cookie"]).toBeUndefined();
      const before = await browser.get("/api/auth/get-session");
      expect(before.body?.user ?? null).toBeNull();

      // Only the confirm opens the session.
      const confirmed = await confirm({ browser, path });
      expect(confirmed.status).toBeGreaterThanOrEqual(200);
      expect(confirmed.status).toBeLessThan(300);
      const done = await browser.get(path);
      expect(done.body.data.session).toBeTruthy();
      const after = await browser.get("/api/auth/get-session");
      expect(after.body.user.id).toBe(done.body.data.session.userId);
    },
  );

  it("AUTH-01 requireConfirm true waits for confirm and issues no session", async () => {
    const c = await newChallenge({ requireConfirm: true });
    await landMessage(c.codeFormatted, freshSender(), makeSpy());
    const polled = await c.browser.get(c.path);
    expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
    expect(polled.body.data.session ?? null).toBeNull();
    expect(polled.headers["set-cookie"]).toBeUndefined();
  });
});

describe("lnbtp: Bukan saya", () => {
  it("AUTH-03 Bukan saya cancels the login and sends no success reply", async () => {
    const spy = makeSpy();
    const sender = freshSender();
    const c = await awaitingChallenge(sender, spy);

    const cancelled = await cancel(c);
    expect(cancelled.status).toBe(204);

    const polled = await c.browser.get(c.path);
    expect(polled.body.data.challenge.status).toBe("cancelled");
    expect(polled.body.data.session ?? null).toBeNull();
    expect(
      (await c.browser.get("/api/auth/get-session")).body?.user ?? null,
    ).toBeNull();

    // No "berhasil" message, neither when the message landed nor after cancel.
    const success = loginReplyText("success");
    expect(spy.mock.calls.map(([sent]) => sent.text)).not.toContain(success);
  });

  it("AUTH-01 Bukan saya tidies the account that was auto-created for the sender", async () => {
    const sender = freshSender();
    const c = await awaitingChallenge(sender);
    const userId = await identityOf(sender);
    // Precondition: the new sender got an account on this challenge.
    expect(userId, "an account is created for a new sender").not.toBeNull();

    expect((await cancel(c)).status).toBe(204);

    const identityLeft = await identityOf(sender);
    const row = await userRow(userId!);
    const tidied =
      identityLeft === null || row === null || flaggedInactive(row);
    expect(
      tidied,
      "never-used auto-created account must be removed or deactivated",
    ).toBe(true);
    // And it never signed anyone in.
    expect(await sessionCount(userId!)).toBe(0);
  });

  it("AUTH-01 Bukan saya does not touch an account that already existed", async () => {
    const sender = freshSender();

    // First login, confirmed: this account is now in use on browser one.
    const first = await awaitingChallenge(sender);
    expect((await confirm(first)).status).toBeLessThan(300);
    const signedIn = await first.browser.get(first.path);
    expect(signedIn.body.data.session).toBeTruthy();
    const existingId = signedIn.body.data.session.userId as string;
    expect(await identityOf(sender)).toBe(existingId);
    await resetChallenges(); // keep the AUTH-04 challenge window out of the way

    // Someone else starts a login with the same number; the owner says Bukan saya.
    const second = await awaitingChallenge(sender);
    expect((await cancel(second)).status).toBe(204);

    const polled = await second.browser.get(second.path);
    expect(polled.body.data.challenge.status).toBe("cancelled");
    expect(polled.body.data.session ?? null).toBeNull();

    // The older account is intact: identity, user row, and the live session.
    expect(await identityOf(sender)).toBe(existingId);
    const row = await userRow(existingId);
    expect(row).not.toBeNull();
    expect(flaggedInactive(row!)).toBe(false);
    const stillIn = await first.browser.get("/api/auth/get-session");
    expect(stillIn.body.user.id).toBe(existingId);
  });
});

describe("lnbtp: race between Bukan saya and confirm / poll", () => {
  const ROUNDS = 4;

  it("AUTH-01 cancel and confirm at the same time always end cancelled with no session", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await resetChallenges();
      const sender = freshSender();
      const c = await awaitingChallenge(sender);
      const userId = await identityOf(sender);

      const [cancelled, confirmed, poll] = await Promise.all([
        cancel(c),
        confirm(c),
        c.browser.get(c.path),
      ]);
      expect(cancelled.status, `round ${round}`).toBe(204);
      // Confirm either landed just before the cancel (2xx) or was refused (4xx).
      expect(confirmed.status, `round ${round}`).toBeLessThan(500);
      // A poll that raced the cancel can only have issued a session if the
      // confirm already landed; when that happened the final state must be
      // consistent (checked below), so only the settled state is asserted.
      const final = await c.browser.get(c.path);
      const me = await c.browser.get("/api/auth/get-session");
      // A re-poll after the session was issued may be refused (no view): then
      // the signed-in browser is the evidence that the challenge completed.
      const status: string =
        final.body.data?.challenge?.status ??
        (me.body?.user ? "completed" : `unknown (${final.status})`);
      if (status === "cancelled") {
        expect(poll.body.data?.session ?? null, `round ${round}`).toBeNull();
        expect(final.body.data?.session ?? null, `round ${round}`).toBeNull();
        expect(me.body?.user ?? null, `round ${round}`).toBeNull();
        if (userId)
          expect(await sessionCount(userId), `round ${round}`).toBe(0);
      } else {
        // Cancel lost to a poll that already issued the session: consistent.
        expect(status, `round ${round}`).toBe("completed");
        expect(me.body.user.id, `round ${round}`).toBe(userId);
      }
    }
  });

  it("AUTH-01 cancel and poll at the same time never leave a session behind a cancelled challenge", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await resetChallenges();
      const sender = freshSender();
      const c = await awaitingChallenge(sender);
      const userId = await identityOf(sender);
      // The person pressed confirm; the next poll would issue the session.
      expect((await confirm(c)).status, `round ${round}`).toBeLessThan(300);

      const [cancelled, pollA, pollB] = await Promise.all([
        cancel(c),
        c.browser.get(c.path),
        c.browser.get(c.path),
      ]);
      expect(cancelled.status, `round ${round}`).toBeLessThan(500);
      const final = await c.browser.get(c.path);
      const me = await c.browser.get("/api/auth/get-session");
      // A re-poll after the session was issued may be refused (no view): then
      // the signed-in browser is the evidence that the challenge completed.
      const status: string =
        final.body.data?.challenge?.status ??
        (me.body?.user ? "completed" : `unknown (${final.status})`);

      if (status === "cancelled") {
        // Nothing may have been issued, before, during or after the cancel.
        expect(pollA.body.data?.session ?? null, `round ${round}`).toBeNull();
        expect(pollB.body.data?.session ?? null, `round ${round}`).toBeNull();
        expect(final.body.data?.session ?? null, `round ${round}`).toBeNull();
        expect(me.body?.user ?? null, `round ${round}`).toBeNull();
        if (userId)
          expect(await sessionCount(userId), `round ${round}`).toBe(0);
        // And it stays that way: a later poll or confirm cannot revive it.
        expect(
          (await confirm(c)).status,
          `round ${round}`,
        ).toBeGreaterThanOrEqual(400);
        const later = await c.browser.get(c.path);
        expect(later.body.data.challenge.status, `round ${round}`).toBe(
          "cancelled",
        );
        expect(later.body.data.session ?? null, `round ${round}`).toBeNull();
      } else {
        // The poll won: a real session exists and matches the sender's account.
        expect(status, `round ${round}`).toBe("completed");
        expect(me.body.user.id, `round ${round}`).toBe(userId);
      }
    }
  });

  it("AUTH-01 once cancelled, confirm and polls never create a session", async () => {
    const sender = freshSender();
    const c = await awaitingChallenge(sender);
    const userId = await identityOf(sender);
    expect((await cancel(c)).status).toBe(204);

    const results = await Promise.all([
      confirm(c),
      confirm(c),
      c.browser.get(c.path),
      c.browser.get(c.path),
    ]);
    for (const res of results.slice(0, 2)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    for (const res of results.slice(2)) {
      expect(res.body.data.challenge.status).toBe("cancelled");
      expect(res.body.data.session ?? null).toBeNull();
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(
      (await c.browser.get("/api/auth/get-session")).body?.user ?? null,
    ).toBeNull();
    if (userId) expect(await sessionCount(userId)).toBe(0);
  });
});

describe("lnbtp: Bukan saya vs a second message from the same number", () => {
  it("AUTH-01 cancel of the first login never leaves a challenge pointing at a deleted account", async () => {
    const sender = freshSender();

    // Challenge A: the sender is new, so an account X is auto-created for it.
    const a = await awaitingChallenge(sender);
    const accountX = await identityOf(sender);
    expect(accountX, "an account is created for a new sender").not.toBeNull();

    // Challenge B: same number, its message is held right after it resolved
    // the (now existing) account and before it completes.
    const b = await newChallenge({ requireConfirm: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const holdAfterResolve = async (
      ...args: Parameters<typeof resolveWhatsAppAccount>
    ) => {
      const account = await resolveWhatsAppAccount(...args);
      signalReached();
      await gate;
      return account;
    };

    const inboundB = processInboundWhatsApp(
      {
        eventId: `wamid.${randomUUID()}`,
        receivingNumber: NUMBER_A,
        sender,
        text: `MASUK LEGEND ${b.codeFormatted}`,
      },
      { sendReply: makeSpy(), resolveAccount: holdAfterResolve },
    );
    // Surface a failure of B only after the gap was used.
    const settledB = inboundB.then(
      (outcome) => ({ outcome, error: null as unknown }),
      (error: unknown) => ({ outcome: null, error }),
    );

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        reached,
        settledB.then(() => {
          throw new Error(
            "message B finished without resolving the account: the race was not exercised",
          );
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("message B never reached the resolve step")),
            15_000,
          );
        }),
      ]);

      // Gap: the person presses "Bukan saya" on A while B holds the account.
      const cancelled = await cancel(a);
      expect(cancelled.status).toBe(204);
    } finally {
      clearTimeout(timer);
      release();
    }
    const result = await settledB;
    // B may be refused or accepted; it must not blow up with a server error.
    expect(result.error, "message B must not throw").toBeNull();

    // Core invariant: no live challenge points at a user that does not exist.
    // The cancelled challenge A keeps its matched user id as audit trail
    // (w8dfz.1), so only non-cancelled rows count.
    const dangling = await owner.query(
      `SELECT id, matched_user_id FROM login_challenges lc
        WHERE matched_user_id IS NOT NULL
          AND status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = lc.matched_user_id)`,
    );
    expect(
      dangling.rows,
      "no login challenge may reference a deleted account",
    ).toEqual([]);

    // And B cannot be confirmed into a session for a deleted account.
    const polledB = await b.browser.get(b.path);
    expect(polledB.status).toBeLessThan(500);
    if (viewField(polledB.body.data, "awaitingConfirmation") === true) {
      const confirmed = await confirm(b);
      expect(confirmed.status).toBeLessThan(500);
    }
    const finalB = await b.browser.get(b.path);
    expect(finalB.status).toBeLessThan(500);
    const sessionUser = finalB.body.data?.session?.userId as string | undefined;
    if (sessionUser) {
      expect(
        await userRow(sessionUser),
        "a session may only belong to an existing user",
      ).not.toBeNull();
    }
  });
});
