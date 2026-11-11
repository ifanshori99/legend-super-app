// WS12 Tanya AI + MCP UI pure logic (docs/briefs/sub-539-u3-ai-mcp.md, parts
// P1 chat, P3 action, P4 consent, P5 admin). Loaded with native Node type
// stripping, like tests/payslip-pin-ui.test.mjs. Written from the brief only.
//
// Assumptions where the brief is silent:
// - Error code wins over HTTP status (AI_FEATURE_DISABLED on a 403 is
//   "unavailable", AI_QUOTA_EXCEEDED is "quota" whatever the status).
// - parseConsentQuery returns an object holding exactly the present, non-empty
//   whitelisted keys (values URL-decoded, "+" decoded as a space).
// - buildDenyRedirect places the existing query first, then error, then state.
// - mcpTokenState/clientRevokeImpact: "active" means not revoked and
//   expiresAt strictly after now (expiresAt === now is expired).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { classifyAskError } from "../apps/web/src/features/ws12-ai-chat/logic.ts";
import { actionStatusView } from "../apps/web/src/features/ws12-ai-action/logic.ts";
import {
  CONSENT_RESUME_KEY,
  buildAuthorizeBody,
  buildDenyRedirect,
  buildResumeReturnPath,
  isResumeSearch,
  parseConsentQuery,
} from "../apps/web/src/features/ws12-ai-consent/logic.ts";
import {
  budgetPercent,
  clientRevokeImpact,
  mcpTokenState,
} from "../apps/web/src/features/ws12-ai-admin/logic.ts";

const LOGIC_FILES = [
  "ws12-ai-chat",
  "ws12-ai-action",
  "ws12-ai-consent",
  "ws12-ai-admin",
];

const now = new Date("2026-11-12T10:00:00.000Z");
const err = (status, code) => new ApiError(status, code, `${code} message`);

describe("ws12 logic modules", () => {
  for (const folder of LOGIC_FILES) {
    test(`${folder}/logic.ts has no framework imports`, () => {
      const source = readFileSync(
        new URL(`../apps/web/src/features/${folder}/logic.ts`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(source, /from\s+["']react/);
      assert.doesNotMatch(source, /from\s+["']@tanstack/);
      assert.doesNotMatch(source, /from\s+["'](next|vite)/);
      assert.doesNotMatch(source, /from\s+["']@\/components/);
      assert.doesNotMatch(source, /from\s+["']motion/);
    });
  }
});

describe("classifyAskError (P1)", () => {
  test("AI_TOOL_FORBIDDEN is denied", () => {
    assert.equal(classifyAskError(err(403, "AI_TOOL_FORBIDDEN")), "denied");
  });

  test("any other 403 is denied", () => {
    assert.equal(classifyAskError(err(403, "FORBIDDEN")), "denied");
    assert.equal(classifyAskError(err(403, "SOMETHING_NEW")), "denied");
  });

  test("feature, tool and provider outages are unavailable", () => {
    for (const code of [
      "AI_FEATURE_DISABLED",
      "AI_TOOL_DISABLED",
      "AI_PROVIDER_UNAVAILABLE",
      "AI_PROVIDER_NOT_CONFIGURED",
    ]) {
      assert.equal(classifyAskError(err(503, code)), "unavailable", code);
    }
  });

  test("listed unavailable codes win over a 403 status", () => {
    assert.equal(
      classifyAskError(err(403, "AI_FEATURE_DISABLED")),
      "unavailable",
    );
    assert.equal(classifyAskError(err(403, "AI_TOOL_DISABLED")), "unavailable");
  });

  test("any 503 is unavailable", () => {
    assert.equal(classifyAskError(err(503, "UNKNOWN")), "unavailable");
    assert.equal(
      classifyAskError(err(503, "SERVICE_UNAVAILABLE")),
      "unavailable",
    );
  });

  test("non-ApiError (network failure) is unavailable", () => {
    assert.equal(
      classifyAskError(new TypeError("Failed to fetch")),
      "unavailable",
    );
    assert.equal(classifyAskError(new Error("boom")), "unavailable");
    assert.equal(classifyAskError("offline"), "unavailable");
    assert.equal(classifyAskError(null), "unavailable");
    assert.equal(classifyAskError(undefined), "unavailable");
    assert.equal(classifyAskError({ status: 403, code: "X" }), "unavailable");
  });

  test("quota, budget and pii map to their own kind", () => {
    assert.equal(classifyAskError(err(429, "AI_QUOTA_EXCEEDED")), "quota");
    assert.equal(classifyAskError(err(402, "AI_BUDGET_EXCEEDED")), "budget");
    assert.equal(classifyAskError(err(429, "AI_BUDGET_EXCEEDED")), "budget");
    assert.equal(classifyAskError(err(422, "AI_PII_BLOCKED")), "pii");
    assert.equal(classifyAskError(err(400, "AI_PII_BLOCKED")), "pii");
  });

  test("anything else is a generic error", () => {
    assert.equal(classifyAskError(err(500, "INTERNAL_ERROR")), "error");
    assert.equal(classifyAskError(err(400, "VALIDATION_ERROR")), "error");
    assert.equal(classifyAskError(err(404, "NOT_FOUND")), "error");
    assert.equal(classifyAskError(err(401, "UNAUTHENTICATED")), "error");
    assert.equal(classifyAskError(err(500, "AI_UNKNOWN")), "error");
  });
});

describe("actionStatusView (P3)", () => {
  const expected = {
    pending: "waiting",
    approved: "info",
    executed: "success",
    rejected: "danger",
    failed: "danger",
    expired: "muted",
  };

  for (const [status, tone] of Object.entries(expected)) {
    test(`${status} is ${tone} with its catalog key`, () => {
      assert.deepEqual(actionStatusView(status), {
        tone,
        labelKey: `aiAction.status.${status}`,
      });
    });
  }

  test("every status has a distinct label key", () => {
    const keys = Object.keys(expected).map((s) => actionStatusView(s).labelKey);
    assert.equal(new Set(keys).size, 6);
  });
});

describe("parseConsentQuery (P4)", () => {
  const full =
    "client_id=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code" +
    "&scope=ai.read+ai.ask&state=xyz&code_challenge=chal&code_challenge_method=S256";

  test("reads all seven keys", () => {
    assert.deepEqual(parseConsentQuery(full), {
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "ai.read ai.ask",
      state: "xyz",
      code_challenge: "chal",
      code_challenge_method: "S256",
    });
  });

  test("leading ? is optional", () => {
    assert.deepEqual(parseConsentQuery(`?${full}`), parseConsentQuery(full));
  });

  test("keeps only present keys", () => {
    assert.deepEqual(
      parseConsentQuery(
        "?client_id=abc&redirect_uri=https%3A%2F%2Fa.test%2Fcb",
      ),
      { client_id: "abc", redirect_uri: "https://a.test/cb" },
    );
  });

  test("drops empty values", () => {
    assert.deepEqual(
      parseConsentQuery(
        "?client_id=abc&redirect_uri=https%3A%2F%2Fa.test%2Fcb&scope=&state=",
      ),
      { client_id: "abc", redirect_uri: "https://a.test/cb" },
    );
  });

  test("drops unknown keys", () => {
    const q = parseConsentQuery(
      "?client_id=abc&redirect_uri=https%3A%2F%2Fa.test%2Fcb&utm_source=x&approve=true",
    );
    assert.deepEqual(q, {
      client_id: "abc",
      redirect_uri: "https://a.test/cb",
    });
  });

  test("null when client_id or redirect_uri is missing", () => {
    assert.equal(
      parseConsentQuery("?redirect_uri=https%3A%2F%2Fa.test%2Fcb"),
      null,
    );
    assert.equal(parseConsentQuery("?client_id=abc"), null);
    assert.equal(parseConsentQuery("?state=xyz&scope=ai.ask"), null);
  });

  test("null when client_id or redirect_uri is empty", () => {
    assert.equal(
      parseConsentQuery("?client_id=&redirect_uri=https%3A%2F%2Fa.test%2Fcb"),
      null,
    );
    assert.equal(parseConsentQuery("?client_id=abc&redirect_uri="), null);
  });

  test("null for an empty search string", () => {
    assert.equal(parseConsentQuery(""), null);
    assert.equal(parseConsentQuery("?"), null);
  });
});

describe("parseConsentQuery keeps OAuth values exactly (P4)", () => {
  const base = "?client_id=a&redirect_uri=https%3A%2F%2Fx.test%2Fcb";
  for (const state of ["12345678901234567890", "1e5", "null", "%22x%22"]) {
    test(`state=${state} is not re-serialised`, () => {
      const q = parseConsentQuery(`${base}&state=${state}`);
      assert.equal(q.state, decodeURIComponent(state));
    });
  }
});

describe("consent resume helpers (P4)", () => {
  test("storage key and return path are fixed", () => {
    assert.equal(CONSENT_RESUME_KEY, "legend.mcpConsent.resume");
    assert.equal(buildResumeReturnPath(), "/mcp/consent?resume=1");
  });

  test("return path fits the 300 character sign-in rule", () => {
    assert.ok(buildResumeReturnPath().length <= 300);
  });

  test("isResumeSearch is true for resume=1 without client_id", () => {
    assert.equal(isResumeSearch("?resume=1"), true);
    assert.equal(isResumeSearch("resume=1"), true);
  });

  test("isResumeSearch is false for other searches", () => {
    assert.equal(isResumeSearch(""), false);
    assert.equal(isResumeSearch("?resume=0"), false);
    assert.equal(isResumeSearch("?resume=true"), false);
    assert.equal(
      isResumeSearch("?resume=1&client_id=a&redirect_uri=https%3A%2F%2Fx.test"),
      false,
    );
    assert.equal(isResumeSearch("?client_id=a"), false);
  });
});

describe("buildDenyRedirect (P4)", () => {
  test("sets error=access_denied and echoes state", () => {
    const href = buildDenyRedirect({
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
      state: "xyz",
    });
    const url = new URL(href);
    assert.equal(url.origin + url.pathname, "https://app.example/cb");
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("state"), "xyz");
    assert.equal(href, "https://app.example/cb?error=access_denied&state=xyz");
  });

  test("omits state when absent", () => {
    const href = buildDenyRedirect({
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
    });
    const url = new URL(href);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.has("state"), false);
  });

  test("keeps the existing query of redirect_uri", () => {
    const url = new URL(
      buildDenyRedirect({
        client_id: "abc",
        redirect_uri: "https://app.example/cb?tenant=cafe&x=1",
        state: "s1",
      }),
    );
    assert.equal(url.searchParams.get("tenant"), "cafe");
    assert.equal(url.searchParams.get("x"), "1");
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("state"), "s1");
  });

  test("replaces an existing error or state instead of duplicating", () => {
    const url = new URL(
      buildDenyRedirect({
        client_id: "abc",
        redirect_uri: "https://app.example/cb?error=other&state=old",
        state: "new",
      }),
    );
    assert.deepEqual(url.searchParams.getAll("error"), ["access_denied"]);
    assert.deepEqual(url.searchParams.getAll("state"), ["new"]);
  });

  test("supports a custom-scheme redirect_uri", () => {
    const url = new URL(
      buildDenyRedirect({
        client_id: "abc",
        redirect_uri: "claude://oauth/callback",
        state: "xyz",
      }),
    );
    assert.equal(url.protocol, "claude:");
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("state"), "xyz");
  });

  test("null for an invalid redirect_uri", () => {
    assert.equal(
      buildDenyRedirect({ client_id: "abc", redirect_uri: "not a url" }),
      null,
    );
    assert.equal(
      buildDenyRedirect({ client_id: "abc", redirect_uri: "/relative/path" }),
      null,
    );
  });

  test("does not mutate its input", () => {
    const q = { client_id: "abc", redirect_uri: "https://app.example/cb" };
    buildDenyRedirect(q);
    assert.deepEqual(q, {
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
    });
  });
});

describe("buildAuthorizeBody (P4)", () => {
  test("adds approve: true to every query key", () => {
    const q = {
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "ai.read",
      state: "xyz",
      code_challenge: "chal",
      code_challenge_method: "S256",
    };
    assert.deepEqual(buildAuthorizeBody(q), { ...q, approve: true });
  });

  test("keeps snake_case keys and adds no absent keys", () => {
    const body = buildAuthorizeBody({
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
    });
    assert.deepEqual(body, {
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
      approve: true,
    });
    assert.equal("state" in body, false);
  });

  test("does not mutate its input", () => {
    const q = { client_id: "abc", redirect_uri: "https://app.example/cb" };
    buildAuthorizeBody(q);
    assert.equal("approve" in q, false);
  });

  test("round-trips from parseConsentQuery", () => {
    const q = parseConsentQuery(
      "?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz&junk=1",
    );
    assert.deepEqual(buildAuthorizeBody(q), {
      client_id: "abc",
      redirect_uri: "https://app.example/cb",
      state: "xyz",
      approve: true,
    });
  });
});

describe("mcpTokenState (P5)", () => {
  test("active when not revoked and expiry is in the future", () => {
    assert.equal(
      mcpTokenState(
        { expiresAt: "2026-11-12T10:00:01.000Z", revokedAt: null },
        now,
      ),
      "active",
    );
    assert.equal(
      mcpTokenState(
        { expiresAt: "2027-01-01T00:00:00.000Z", revokedAt: null },
        now,
      ),
      "active",
    );
  });

  test("expired when expiry is in the past", () => {
    assert.equal(
      mcpTokenState(
        { expiresAt: "2026-11-12T09:59:59.000Z", revokedAt: null },
        now,
      ),
      "expired",
    );
  });

  test("expired exactly at now", () => {
    assert.equal(
      mcpTokenState({ expiresAt: now.toISOString(), revokedAt: null }, now),
      "expired",
    );
  });

  test("revoked when revokedAt is set", () => {
    assert.equal(
      mcpTokenState(
        {
          expiresAt: "2027-01-01T00:00:00.000Z",
          revokedAt: "2026-11-11T00:00:00.000Z",
        },
        now,
      ),
      "revoked",
    );
  });

  test("revoked wins over expired", () => {
    assert.equal(
      mcpTokenState(
        {
          expiresAt: "2026-01-01T00:00:00.000Z",
          revokedAt: "2026-02-01T00:00:00.000Z",
        },
        now,
      ),
      "revoked",
    );
  });
});

describe("clientRevokeImpact (P5)", () => {
  const future = "2027-01-01T00:00:00.000Z";
  const past = "2026-01-01T00:00:00.000Z";
  const tok = (clientId, userId, over = {}) => ({
    clientId,
    userId,
    expiresAt: future,
    revokedAt: null,
    ...over,
  });

  test("empty list means no impact", () => {
    assert.deepEqual(clientRevokeImpact([], "c1", now), {
      activeTokens: 0,
      users: 0,
    });
  });

  test("counts active tokens and distinct users of that client only", () => {
    const tokens = [
      tok("c1", "u1"),
      tok("c1", "u1"),
      tok("c1", "u2"),
      tok("c2", "u3"),
      tok("c2", "u1"),
    ];
    assert.deepEqual(clientRevokeImpact(tokens, "c1", now), {
      activeTokens: 3,
      users: 2,
    });
    assert.deepEqual(clientRevokeImpact(tokens, "c2", now), {
      activeTokens: 2,
      users: 2,
    });
  });

  test("ignores expired and revoked tokens", () => {
    const tokens = [
      tok("c1", "u1"),
      tok("c1", "u2", { expiresAt: past }),
      tok("c1", "u3", { revokedAt: "2026-11-11T00:00:00.000Z" }),
      tok("c1", "u4", { expiresAt: now.toISOString() }),
    ];
    assert.deepEqual(clientRevokeImpact(tokens, "c1", now), {
      activeTokens: 1,
      users: 1,
    });
  });

  test("a user with only inactive tokens is not counted", () => {
    const tokens = [
      tok("c1", "u1"),
      tok("c1", "u1", { expiresAt: past }),
      tok("c1", "u2", { expiresAt: past }),
    ];
    assert.deepEqual(clientRevokeImpact(tokens, "c1", now), {
      activeTokens: 1,
      users: 1,
    });
  });

  test("unknown client has no impact", () => {
    assert.deepEqual(clientRevokeImpact([tok("c1", "u1")], "nope", now), {
      activeTokens: 0,
      users: 0,
    });
  });
});

describe("budgetPercent (P5)", () => {
  test("null when there is no cap or the cap is not positive", () => {
    assert.equal(budgetPercent(5000, null), null);
    assert.equal(budgetPercent(5000, 0), null);
    assert.equal(budgetPercent(5000, -100), null);
    assert.equal(budgetPercent(0, 0), null);
  });

  test("whole percentages", () => {
    assert.equal(budgetPercent(0, 100000), 0);
    assert.equal(budgetPercent(50000, 100000), 50);
    assert.equal(budgetPercent(80000, 100000), 80);
    assert.equal(budgetPercent(100000, 100000), 100);
  });

  test("floors fractions, never rounds up", () => {
    assert.equal(budgetPercent(79999, 100000), 79);
    assert.equal(budgetPercent(1, 3), 33);
    assert.equal(budgetPercent(2, 3), 66);
    assert.equal(budgetPercent(999, 100000), 0);
  });

  test("is not clamped above 100", () => {
    assert.equal(budgetPercent(150000, 100000), 150);
    assert.equal(budgetPercent(100999, 100000), 100);
    assert.equal(budgetPercent(1000000, 100000), 1000);
  });

  test("never negative", () => {
    assert.equal(budgetPercent(-5000, 100000), 0);
  });
});
