// Identity & access contract tests (WS-01, bead legend-7sz): login challenges,
// WhatsApp reverse OTP, magic link, Google, identity graph, MFA, device pin,
// sessions, approval requests and the RBAC fixtures the inbox reuses.
// PRD v1.7 §3 F6/F7, §6 B; acceptance AUTH-01..07.
// Loaded with plain Node ESM (type stripping, no resolve hook).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as identity from "../packages/shared/src/identity/index.ts";
import * as access from "../packages/shared/src/access/index.ts";
import * as core from "../packages/shared/src/core/index.ts";
import * as events from "../packages/shared/src/events/index.ts";

const fx = identity.cafeLegendIdentityFixtures;
const now = fx.now;
const MINUTE = 60_000;
const at = (minutes) => new Date(now.getTime() - minutes * MINUTE);
const iso = (date) => date.toISOString();
const identityOf = (key) => fx.identities.filter((row) => row.userId === key);
const challengeById = (id) => fx.loginChallenges.find((row) => row.id === id);
const requestById = (id) => fx.approvalRequests.find((row) => row.id === id);
const sessionOf = (userKey, nth = 0) =>
  fx.sessions.filter((row) => row.userId === userKey)[nth];
const throwsCode = (fn, errorClass, code) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof errorClass, String(error));
    assert.equal(error.code, code);
    return true;
  });

describe("login code and message (AUTH-01)", () => {
  test("AUTH-01: a code carries at least 40 bits in 8 Crockford symbols", () => {
    assert.equal(identity.LOGIN_CODE_ALPHABET.length, 32);
    assert.equal(identity.LOGIN_CODE_LENGTH, 8);
    assert.ok(identity.LOGIN_CODE_ENTROPY_BITS >= 40);
    // I, L, O, U are outside the alphabet; O/I/L are read as 0/1.
    assert.equal(identity.normalizeLoginCode("K7Q4M2XD"), "K7Q4M2XD");
    assert.equal(identity.normalizeLoginCode("k7q4-m2xd"), "K7Q4M2XD");
    assert.equal(identity.normalizeLoginCode("K7Q4 M2XD"), "K7Q4M2XD");
    assert.equal(identity.normalizeLoginCode("K7Q4M2XU"), null);
    assert.equal(identity.normalizeLoginCode("K7Q4M2X"), null);
    assert.equal(identity.normalizeLoginCode(null), null);
    assert.equal(identity.formatLoginCode("K7Q4M2XD"), "K7Q4-M2XD");
    assert.throws(() => identity.formatLoginCode("nope"), RangeError);
  });

  test("AUTH-01: the parser finds the code after any tenant keyword", () => {
    assert.equal(
      identity.loginCodeFromMessage("MASUK LEGEND K7Q4-M2XD"),
      "K7Q4M2XD",
    );
    assert.equal(
      identity.loginCodeFromMessage("masuk cafe legend K7Q4 M2XD"),
      "K7Q4M2XD",
    );
    assert.equal(identity.loginCodeFromMessage("halo K7Q4-M2XD"), null);
    assert.equal(identity.loginCodeFromMessage("MASUK LEGEND"), null);
    assert.equal(
      identity.whatsAppLoginMessage("K7Q4M2XD"),
      "MASUK LEGEND K7Q4-M2XD",
    );
    assert.equal(
      identity.whatsAppLoginDeepLink({
        numberDigits: fx.login.number,
        code: "K7Q4M2XD",
      }),
      "https://wa.me/6281223344556?text=MASUK%20LEGEND%20K7Q4-M2XD",
    );
  });

  test("AUTH-01: five minutes, single use, bound to the requesting browser", () => {
    const issuedAt = new Date("2026-11-01T04:57:00.000Z");
    assert.equal(
      iso(identity.loginChallengeExpiry("whatsapp_inbound", issuedAt)),
      "2026-11-01T05:02:00.000Z",
    );
    assert.equal(
      iso(identity.loginChallengeExpiry("email_magic_link", issuedAt)),
      "2026-11-01T05:12:00.000Z",
    );

    const pending = challengeById(fx.loginChallenges[0].id);
    const completed = identity.completeLoginChallenge({
      challenge: pending,
      browserBindingMatches: true,
      matchedUserId: fx.usersByKey.sari.id,
      completedAt: now,
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.matchedUserId, fx.usersByKey.sari.id);
    assert.equal(completed.completedAt, iso(now));

    // A repeated message (or any second completion) never opens a session.
    throwsCode(
      () =>
        identity.completeLoginChallenge({
          challenge: completed,
          browserBindingMatches: true,
          matchedUserId: fx.usersByKey.sari.id,
          completedAt: now,
        }),
      identity.IdentityError,
      "CHALLENGE_NOT_PENDING",
    );
    throwsCode(
      () =>
        identity.completeLoginChallenge({
          challenge: pending,
          browserBindingMatches: false,
          matchedUserId: fx.usersByKey.sari.id,
          completedAt: now,
        }),
      identity.IdentityError,
      "CHALLENGE_BROWSER_MISMATCH",
    );
    throwsCode(
      () =>
        identity.completeLoginChallenge({
          challenge: pending,
          browserBindingMatches: true,
          matchedUserId: fx.usersByKey.sari.id,
          completedAt: new Date(Date.parse(pending.expiresAt) + 1_000),
        }),
      identity.IdentityError,
      "CHALLENGE_EXPIRED",
    );
  });

  test("AUTH-01: an email link works from another browser, the WhatsApp code does not", () => {
    const email = fx.loginChallenges.find(
      (row) => row.channel === "email_magic_link",
    );
    const completed = identity.completeLoginChallenge({
      challenge: email,
      browserBindingMatches: false,
      matchedUserId: fx.usersByKey.sari.id,
      completedAt: now,
    });
    assert.equal(completed.status, "completed");
  });

  test("AUTH-01: an expired pending challenge sweeps to expired and stays closed", () => {
    const pending = challengeById(fx.loginChallenges[0].id);
    const late = new Date(Date.parse(pending.expiresAt) + 1_000);
    const expired = identity.expireLoginChallenge(pending, late);
    assert.equal(expired.status, "expired");
    assert.ok(identity.loginChallengeSchema.parse(expired));
    assert.equal(identity.expireLoginChallenge(expired, late), expired);
    assert.equal(
      identity.expireLoginChallenge(pending, now),
      pending,
      "not yet due",
    );
  });

  test("AUTH-02: a repeated message and an unbound browser never create a session", () => {
    // AUTH-02's signature check and message-id dedupe live in the adapters
    // contract (KirimDev); identity's half is that only the browser-bound,
    // still-pending challenge can complete, exactly once.
    const pending = challengeById(fx.loginChallenges[0].id);
    const first = identity.completeLoginChallenge({
      challenge: pending,
      browserBindingMatches: true,
      matchedUserId: fx.usersByKey.sari.id,
      completedAt: now,
    });
    assert.equal(first.status, "completed");
    for (const challenge of [first, { ...first, status: "cancelled" }])
      throwsCode(
        () =>
          identity.completeLoginChallenge({
            challenge,
            browserBindingMatches: true,
            matchedUserId: fx.usersByKey.sari.id,
            completedAt: now,
          }),
        identity.IdentityError,
        "CHALLENGE_NOT_PENDING",
      );
  });
});

describe("rate limits and reply policy (AUTH-03, AUTH-04)", () => {
  test("AUTH-03: no reply by default, and replies stop at the free quota", () => {
    assert.equal(identity.WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT, false);
    assert.equal(identity.shouldSendLoginReply(fx.loginReplyPolicy), false);
    assert.equal(identity.recordLoginReply(fx.loginReplyPolicy).sent, false);

    const enabled = identity.loginReplyPolicySchema.parse({
      enabled: true,
      freeMonthlyQuota: 2,
      repliesThisMonth: 0,
    });
    const first = identity.recordLoginReply(enabled);
    const second = identity.recordLoginReply(first.policy);
    const third = identity.recordLoginReply(second.policy);
    assert.equal(first.sent, true);
    assert.equal(second.sent, true);
    assert.equal(third.sent, false);
    assert.equal(third.policy.repliesThisMonth, 2);
    assert.equal(
      identity.loginReplyPolicySchema.safeParse({
        enabled: true,
        freeMonthlyQuota: -1,
        repliesThisMonth: 0,
      }).success,
      false,
    );
  });

  test("AUTH-04: five open challenges per device or IP in 15 minutes", () => {
    assert.doesNotThrow(() =>
      identity.assertChallengeRateLimit({
        openChallengeOpenedAt: [at(1), at(5), at(10), at(14)],
        now,
      }),
    );
    throwsCode(
      () =>
        identity.assertChallengeRateLimit({
          openChallengeOpenedAt: [at(1), at(5), at(10), at(13), at(14)],
          now,
        }),
      core.CoreError,
      "RATE_LIMITED",
    );
    // A challenge older than the window does not count.
    assert.doesNotThrow(() =>
      identity.assertChallengeRateLimit({
        openChallengeOpenedAt: [at(20), at(5), at(10), at(13), at(14)],
        now,
      }),
    );
  });

  test("AUTH-04: ten login messages per number per hour", () => {
    assert.doesNotThrow(() =>
      identity.assertLoginMessageRateLimit({
        messagesReceivedAt: Array.from({ length: 9 }, (_, i) => at(i + 1)),
        now,
      }),
    );
    throwsCode(
      () =>
        identity.assertLoginMessageRateLimit({
          messagesReceivedAt: Array.from({ length: 10 }, (_, i) => at(i + 1)),
          now,
        }),
      core.CoreError,
      "RATE_LIMITED",
    );
  });
});

describe("sessions and MFA (AUTH-05, §3 F6)", () => {
  test("AUTH-05: a management session without a verified factor cannot open the dashboard", () => {
    const hrSession = sessionOf(fx.usersByKey.hr.id);
    assert.equal(
      identity.sessionGate({
        session: hrSession,
        mfaRequired: true,
        now,
      }),
      "mfa_required",
    );
    assert.deepEqual(
      identity.loginMfaState({ mfaRequired: true, factorCount: 0 }),
      { mfaRequired: true, enrollmentRequired: true },
    );
    assert.deepEqual(
      identity.loginMfaState({ mfaRequired: true, factorCount: 2 }),
      { mfaRequired: true, enrollmentRequired: false },
    );
    // The owner verified in this session, so the gate opens.
    assert.equal(
      identity.sessionGate({
        session: sessionOf(fx.usersByKey.owner.id),
        mfaRequired: true,
        now,
      }),
      "ok",
    );
    // A role that does not require MFA is not blocked (customer session).
    assert.equal(
      identity.sessionGate({
        session: sessionOf(fx.usersByKey.sari.id),
        mfaRequired: false,
        now,
      }),
      "ok",
    );
  });

  test("sessions: customer 90 days, management 30 idle minutes, revoked stays closed", () => {
    const created = new Date("2026-08-20T09:00:00.000Z");
    assert.equal(
      iso(identity.newSessionExpiry("customer", created)),
      "2026-11-18T09:00:00.000Z",
    );
    assert.equal(
      iso(identity.newSessionExpiry("management", created)),
      "2026-08-20T09:30:00.000Z",
    );

    const ownerSession = sessionOf(fx.usersByKey.owner.id);
    const tick = identity.recordSessionActivity({
      session: ownerSession,
      now,
      kind: "user",
    });
    assert.equal(tick.write, true);
    assert.equal(tick.session.lastSeenAt, iso(now));
    assert.equal(tick.session.expiresAt, "2026-11-01T05:30:00.000Z");

    // A background poll never keeps the session alive.
    assert.equal(
      identity.recordSessionActivity({
        session: ownerSession,
        now,
        kind: "background",
      }).write,
      false,
    );
    // Writes are throttled to once a minute.
    assert.equal(
      identity.recordSessionActivity({
        session: ownerSession,
        now: new Date(Date.parse(ownerSession.lastSeenAt) + 30_000),
        kind: "user",
      }).write,
      false,
    );
    // A customer session keeps its absolute end.
    const customer = sessionOf(fx.usersByKey.sari.id);
    assert.equal(
      identity.recordSessionActivity({
        session: customer,
        now,
        kind: "user",
      }).session.expiresAt,
      customer.expiresAt,
    );

    const revoked = sessionOf(fx.usersByKey.dimas.id);
    assert.equal(
      identity.sessionGate({ session: revoked, mfaRequired: false, now }),
      "revoked",
    );
    const expiring = sessionOf(fx.usersByKey.owner.id, 1);
    assert.equal(
      identity.isSessionIdleWarning({ session: expiring, now }),
      true,
    );
    assert.equal(
      identity.sessionGate({
        session: expiring,
        mfaRequired: true,
        now: new Date(Date.parse(expiring.expiresAt) + 1),
      }),
      "expired",
    );
  });
});

describe("staff pin (§3 F6)", () => {
  test("F6: five wrong pins lock the pin, a correct one clears the count", () => {
    let state = { failedAttempts: 0, lockedUntil: null };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      state = identity.recordStaffPinAttempt({ state, correct: false, now });
      assert.equal(state.failedAttempts, attempt);
      assert.equal(state.lockedUntil, null);
    }
    state = identity.recordStaffPinAttempt({ state, correct: false, now });
    assert.equal(state.failedAttempts, identity.MAX_STAFF_PIN_ATTEMPTS);
    assert.notEqual(state.lockedUntil, null);
    assert.equal(identity.isStaffPinLocked(state, now), true);
    throwsCode(
      () => identity.recordStaffPinAttempt({ state, correct: true, now }),
      identity.IdentityError,
      "PIN_LOCKED",
    );
    // After the window the count starts again; a correct pin resets it.
    const later = new Date(Date.parse(state.lockedUntil) + 1_000);
    const fresh = identity.recordStaffPinAttempt({
      state,
      correct: false,
      now: later,
    });
    assert.equal(fresh.failedAttempts, 1);
    assert.equal(fresh.lockedUntil, null);
    assert.deepEqual(
      identity.recordStaffPinAttempt({
        state: fresh,
        correct: true,
        now: later,
      }),
      { failedAttempts: 0, lockedUntil: null },
    );
    // The fixture keeps one pin locked (waiter, 5 misses).
    const lockedFixture = fx.staffPins.find((row) => row.failedAttempts === 5);
    assert.equal(identity.isStaffPinLocked(lockedFixture, now), true);
  });

  test("F6: trivial pins are rejected (all one digit or a straight run)", () => {
    assert.equal(identity.isStrongStaffPin("281947"), true);
    for (const weak of ["123456", "654321", "000000", "111111", "12345"])
      assert.equal(identity.isStrongStaffPin(weak), false, weak);
    throwsCode(
      () => identity.assertStrongStaffPin("123456"),
      identity.IdentityError,
      "WEAK_STAFF_PIN",
    );
  });
});

describe("identity graph (AUTH-07, §3 F6)", () => {
  test("AUTH-07: points need a verified WhatsApp number", () => {
    assert.doesNotThrow(() =>
      identity.assertWhatsAppVerifiedForLoyalty({
        identities: identityOf(fx.usersByKey.sari.id),
      }),
    );
    throwsCode(
      () =>
        identity.assertWhatsAppVerifiedForLoyalty({
          identities: identityOf(fx.usersByKey.dimas.id),
        }),
      identity.IdentityError,
      "WHATSAPP_VERIFICATION_REQUIRED",
    );
    const unverified = identity.userIdentitySchema.parse({
      id: "0c0f0000-0000-4000-8000-0000000000aa",
      userId: fx.usersByKey.dimas.id,
      type: "whatsapp",
      valueMasked: "6281•••••432",
      isPrimary: false,
      verifiedAt: null,
      createdAt: "2026-09-03T07:40:00.000Z",
    });
    throwsCode(
      () =>
        identity.assertWhatsAppVerifiedForLoyalty({
          identities: [...identityOf(fx.usersByKey.dimas.id), unverified],
        }),
      identity.IdentityError,
      "WHATSAPP_VERIFICATION_REQUIRED",
    );
  });

  test("§3 F6: the older account survives a merge and the verified number moves", () => {
    const plan = identity.planIdentityMerge({
      a: fx.usersByKey.dimas,
      b: fx.usersByKey.ayu,
      identities: fx.identities,
    });
    assert.equal(plan.survivorId, fx.usersByKey.dimas.id);
    assert.equal(plan.mergedId, fx.usersByKey.ayu.id);
    assert.equal(plan.movedIdentityIds.length, 1);
    assert.equal(
      plan.verifiedWhatsAppIdentityId,
      identityOf(fx.usersByKey.ayu.id)[0].id,
    );
    // Same createdAt: the smaller id survives, so a merge is deterministic.
    const sameDay = "2026-10-05T08:15:00.000Z";
    const smaller = {
      id: "0c0f0000-0000-4000-8000-000000000001",
      createdAt: sameDay,
    };
    const larger = {
      id: "0c0f0000-0000-4000-8000-000000000002",
      createdAt: sameDay,
    };
    const tied = identity.planIdentityMerge({
      a: larger,
      b: smaller,
      identities: [],
    });
    assert.equal(tied.survivorId, smaller.id);
    assert.equal(tied.mergedId, larger.id);
    assert.equal(tied.movedIdentityIds.length, 0);
    assert.throws(
      () =>
        identity.planIdentityMerge({
          a: fx.usersByKey.dimas,
          b: fx.usersByKey.dimas,
          identities: [],
        }),
      RangeError,
    );
  });

  test("§3 F6: linking is link/merge/sign-in, never a second account", () => {
    assert.equal(
      identity.challengeCompletionAction({
        authenticatedUserId: null,
        resolvedUserId: fx.usersByKey.sari.id,
        identityKnown: true,
      }),
      "sign_in",
    );
    assert.equal(
      identity.challengeCompletionAction({
        authenticatedUserId: fx.usersByKey.dimas.id,
        resolvedUserId: fx.usersByKey.dimas.id,
        identityKnown: false,
      }),
      "link",
    );
    assert.equal(
      identity.challengeCompletionAction({
        authenticatedUserId: fx.usersByKey.dimas.id,
        resolvedUserId: fx.usersByKey.ayu.id,
        identityKnown: true,
      }),
      "merge_required",
    );
    assert.doesNotThrow(() =>
      identity.assertIdentityLinkable({
        ownerUserId: fx.usersByKey.dimas.id,
        userId: fx.usersByKey.dimas.id,
      }),
    );
    throwsCode(
      () =>
        identity.assertIdentityLinkable({
          ownerUserId: fx.usersByKey.ayu.id,
          userId: fx.usersByKey.dimas.id,
        }),
      identity.IdentityError,
      "IDENTITY_ALREADY_LINKED",
    );
    throwsCode(
      () => identity.assertUserStatusTransition("deleted", "active"),
      identity.IdentityError,
      "USER_STATUS_TRANSITION",
    );
  });
});

describe("approval requests and matrix (§3 F7, AUTH-06)", () => {
  test("AUTH-06: an override records requester, approver, reason and value, never the same person", () => {
    const request = requestById(fx.approvalRequests[0].id);
    throwsCode(
      () =>
        identity.recordApprovalDecision({
          request,
          decision: "approved",
          decidedBy: request.requestedBy,
          reason: "Saya setujui sendiri.",
          now,
        }),
      access.AccessError,
      "APPROVER_IS_REQUESTER",
    );
    const decided = identity.recordApprovalDecision({
      request,
      decision: "approved",
      decidedBy: fx.usersByKey.supervisor.id,
      reason: "Bukti QRIS dan struk cocok.",
      now,
    });
    assert.equal(decided.status, "approved");
    assert.equal(decided.decidedBy, fx.usersByKey.supervisor.id);
    assert.equal(decided.decidedAt, iso(now));
    assert.ok(identity.approvalRequestSchema.parse(decided));

    // The POS override record (access contract) links to this request and
    // carries the same requester, approver, reason and value.
    const override = access.posOverrideSchema.parse({
      id: core.createUlid(Date.parse("2026-11-01T05:00:00.000Z")),
      outletId: fx.outletIds.bandung,
      action: "refund",
      requestedBy: request.requestedBy,
      approvedBy: decided.decidedBy,
      method: "supervisor_phone",
      reasonCode: null,
      reason: "Refund QRIS ganda atas pesanan LEG-BDG-20261101-0042.",
      valueIdr: request.amountIdr,
      approvalRequestId: request.id,
      occurredAt: iso(now),
    });
    assert.equal(override.valueIdr, 350_000);
    assert.equal(override.approvalRequestId, request.id);
    assert.notEqual(override.approvedBy, override.requestedBy);
    assert.equal(
      access.posOverrideSchema.safeParse({
        ...override,
        approvedBy: override.requestedBy,
      }).success,
      false,
      "A self-approved override is rejected (AUTH-06)",
    );
  });

  test("F7: one row is one level, and the next level opens only after approval", () => {
    assert.equal(
      identity.nextApprovalLevel(requestById(fx.approvalRequests[5].id)),
      2,
    );
    assert.equal(
      identity.nextApprovalLevel(requestById(fx.approvalRequests[6].id)),
      null,
    );
    assert.equal(
      identity.nextApprovalLevel(requestById(fx.approvalRequests[0].id)),
      null,
    );

    const refund750 = requestById(fx.approvalRequests[5].id);
    const requirement = access.approvalRequirementFor(
      fx.approvalPolicies,
      "refund",
      refund750.amountIdr,
    );
    assert.equal(requirement.required, true);
    assert.equal(requirement.steps.length, refund750.requiredLevels);
    const refund350 = access.approvalRequirementFor(
      fx.approvalPolicies,
      "refund",
      350_000,
    );
    assert.equal(refund350.steps.length, 1);
    const discount = access.approvalRequirementFor(
      fx.approvalPolicies,
      "discount",
      250_000,
    );
    assert.equal(discount.steps.length, 1);
  });

  test("F7: a deadline expires the request and the action stays blocked", () => {
    const pending = requestById(fx.approvalRequests[0].id);
    const late = new Date(Date.parse(pending.deadlineAt) + 1_000);
    assert.equal(identity.isApprovalRequestExpired(pending, late), true);
    const expired = identity.expireApprovalRequest(pending, late);
    assert.equal(expired.status, "expired");
    assert.ok(identity.approvalRequestSchema.parse(expired));
    throwsCode(
      () =>
        identity.recordApprovalDecision({
          request: pending,
          decision: "approved",
          decidedBy: fx.usersByKey.supervisor.id,
          reason: "Terlambat.",
          now: late,
        }),
      identity.IdentityError,
      "APPROVAL_REQUEST_EXPIRED",
    );
    throwsCode(
      () =>
        identity.recordApprovalDecision({
          request: requestById(fx.approvalRequests[4].id),
          decision: "rejected",
          decidedBy: fx.usersByKey.owner.id,
          reason: "Sudah diputuskan.",
          now,
        }),
      identity.IdentityError,
      "APPROVAL_REQUEST_NOT_PENDING",
    );
    assert.equal(identity.approvalRequestIsOpen(pending, now), true);
    assert.equal(identity.approvalRequestIsOpen(pending, late), false);
    // The expired fixture stays expired when swept again.
    const swept = requestById(fx.approvalRequests[7].id);
    assert.equal(identity.expireApprovalRequest(swept, now), swept);
  });
});

describe("events and catalog", () => {
  const definitions = [
    identity.loginChallengeCreatedEvent,
    identity.loginChallengeCompletedEvent,
    identity.identityLinkedEvent,
    identity.sessionCreatedEvent,
    identity.sessionRevokedEvent,
    identity.approvalRequestedEvent,
    identity.approvalDecidedEvent,
  ];

  test("every identity event is catalogued on the WS-01 line and bound to its payload", () => {
    for (const definition of definitions) {
      const entry = events.eventCatalogByName.get(definition.name);
      assert.ok(entry, definition.name);
      assert.equal(entry.workstream, "WS-01");
      assert.equal(entry.version, 1);
      assert.equal(entry.payloadSchemaRef, `${definition.name}.v1`);
    }
  });

  test("an approval.requested envelope validates end to end", () => {
    const request = requestById(fx.approvalRequests[0].id);
    const envelope = identity.approvalRequestedEvent.envelopeSchema.parse({
      id: core.createUlid(),
      tenantId: fx.tenantId,
      outletId: fx.outletIds.bandung,
      name: "approval.requested",
      version: 1,
      aggregateType: "approval",
      aggregateId: request.id,
      sequence: 1,
      occurredAt: iso(now),
      actor: { type: "user", id: request.requestedBy },
      deviceId: null,
      idempotencyKey: "fixture-approval-requested-1",
      payloadSchemaRef: "approval.requested.v1",
      payload: {
        requestId: request.id,
        actionType: request.actionType,
        objectType: request.objectType,
        objectId: request.objectId,
        source: request.source,
        level: request.level,
        requiredLevels: request.requiredLevels,
        requestedBy: request.requestedBy,
        amountIdr: request.amountIdr,
        deadlineAt: request.deadlineAt,
      },
    });
    assert.equal(envelope.payload.requestId, request.id);
  });

  test("no identity event payload carries a secret, code or free text", () => {
    const forbidden =
      /code|token|hash|pin|secret|reason|email|phone|number|ip|agent|binding|value/i;
    for (const definition of definitions) {
      for (const key of Object.keys(definition.payloadSchema.shape))
        assert.equal(forbidden.test(key), false, `${definition.name}.${key}`);
    }
  });
});

describe("fixtures and endpoints", () => {
  test("every Cafe Legend identity fixture parses against its schema", () => {
    for (const user of fx.users) assert.ok(identity.userSchema.parse(user));
    for (const row of fx.identities)
      assert.ok(identity.userIdentitySchema.parse(row));
    for (const row of fx.loginChallenges)
      assert.ok(identity.loginChallengeSchema.parse(row));
    assert.ok(
      identity.loginChallengeIssuedSchema.parse(fx.loginChallengeIssued),
    );
    for (const row of fx.mfaFactors)
      assert.ok(identity.mfaFactorSchema.parse(row));
    assert.ok(identity.loginReplyPolicySchema.parse(fx.loginReplyPolicy));
    for (const row of fx.staffPins)
      assert.ok(identity.staffPinStatusSchema.parse(row));
    for (const row of fx.sessions) assert.ok(identity.sessionSchema.parse(row));
    for (const row of fx.approvalRequests)
      assert.ok(identity.approvalRequestSchema.parse(row));
    const statuses = new Set(fx.approvalRequests.map((row) => row.status));
    assert.deepEqual([...statuses].sort(), [
      "approved",
      "expired",
      "pending",
      "rejected",
    ]);
  });

  test("fixtures keep secrets out and the code shown once", () => {
    const forbidden = [
      "codeHash",
      "browserBindingHash",
      "tokenHash",
      "pinHash",
      "valueHash",
      "valueEncrypted",
      "secretEncrypted",
      "publicKey",
      "ipHash",
      "userAgent",
    ];
    const walk = (value, path) => {
      if (Array.isArray(value))
        return value.forEach((v, i) => walk(v, `${path}.${i}`));
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbidden.includes(key), false, `${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    };
    walk(
      {
        identities: fx.identities,
        loginChallenges: fx.loginChallenges,
        mfaFactors: fx.mfaFactors,
        staffPins: fx.staffPins,
        sessions: fx.sessions,
      },
      "fixtures",
    );
    for (const row of fx.identities) assert.match(row.valueMasked, /•/);
    assert.equal(
      JSON.stringify(fx.loginChallenges).includes(fx.login.demoCode),
      false,
    );
    assert.equal(fx.loginChallengeIssued.code, fx.login.demoCode);
  });

  test("the RBAC fixtures are the access contract's own objects (not redefined)", () => {
    assert.equal(fx.roles, access.cafeLegendAccessFixtures.roles);
    assert.equal(
      fx.approvalPolicies,
      access.cafeLegendAccessFixtures.approvalPolicies,
    );
    assert.equal(
      fx.roleAssignments,
      access.cafeLegendAccessFixtures.assignments,
    );
  });

  test("identity endpoints are unique and client input rejects a tenant field (TEN-02)", () => {
    const endpoints = Object.values(identity).filter(
      (value) =>
        value &&
        typeof value === "object" &&
        typeof value.id === "string" &&
        typeof value.path === "string" &&
        typeof value.method === "string",
    );
    assert.ok(endpoints.length >= 20, String(endpoints.length));
    assert.equal(
      new Set(endpoints.map((row) => row.id)).size,
      endpoints.length,
    );
    for (const endpoint of endpoints)
      assert.equal(endpoint.path.startsWith("/api/"), true, endpoint.id);

    assert.equal(
      identity.createWhatsAppLoginChallengeSchema.safeParse({
        returnTo: "/member",
        tenantId: fx.tenantId,
      }).success,
      false,
    );
    assert.equal(
      identity.approvalDecisionInputSchema.safeParse({
        decision: "approved",
        reason: "Sudah sesuai.",
        tenantId: fx.tenantId,
      }).success,
      false,
    );
    assert.equal(
      identity.createMagicLinkChallengeSchema.parse({ email: "Sari@Gmail.com" })
        .email,
      "Sari@Gmail.com",
    );
  });
});
