// 539-U4 B (legend-8r77t): support-access data layer. The decision guard
// (Owner + 2FA, never impersonated), the error map for the new API codes and
// the calls for the read_write request and the owner decision.
//
// Like the other web data-layer suites this runs in the root node:test suite;
// `callEndpoint` (@/lib/api/endpoint) is replaced by a fake, no network.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const calls = [];
globalThis.__u4bFake = async (endpoint, input) => {
  calls.push({ endpoint, input });
  return { data: {} };
};

const FAKE_ENDPOINT_MODULE =
  "data:text/javascript," +
  encodeURIComponent(
    "export const callEndpoint = (...args) => globalThis.__u4bFake(...args);",
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/endpoint")
      return {
        url: FAKE_ENDPOINT_MODULE,
        format: "module",
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return nextResolve(
        pathToFileURL(resolve("apps/web/src", specifier.slice(2)) + ".ts").href,
        context,
      );
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const dir = "../apps/web/src/features/ws01-support-access";
const { evaluateSupportDecisionGuard, SUPPORT_DECISION_PERMISSION } =
  await import(`${dir}/decision-guard.ts`);
const { supportErrorMessage } = await import(`${dir}/errors.ts`);
const api = await import(`${dir}/api.ts`);
const { ApiError } = await import("../apps/web/src/lib/api/errors.ts");

const owner = {
  authenticated: true,
  permissions: [SUPPORT_DECISION_PERMISSION],
  mfaRequired: true,
  mfaVerified: true,
  supportSession: null,
};

beforeEach(() => {
  calls.length = 0;
});

describe("539-U4 B: useSupportDecisionGuard rules", () => {
  test("owner with a verified second factor may decide", () => {
    assert.deepEqual(evaluateSupportDecisionGuard(owner), {
      canDecide: true,
      reason: null,
    });
  });

  test("an impersonated session never decides, even as owner with 2FA", () => {
    assert.deepEqual(evaluateSupportDecisionGuard(owner, "admin-1"), {
      canDecide: false,
      reason: "impersonating",
    });
    assert.equal(
      evaluateSupportDecisionGuard({
        ...owner,
        supportSession: { accessMode: "read_write", expiresAt: "x" },
      }).reason,
      "impersonating",
    );
  });

  test("without the 2FA step it is mfa_required", () => {
    assert.deepEqual(
      evaluateSupportDecisionGuard({ ...owner, mfaVerified: false }),
      { canDecide: false, reason: "mfa_required" },
    );
  });

  test("a non-owner (no approve permission) or missing access fails closed", () => {
    assert.equal(
      evaluateSupportDecisionGuard({
        ...owner,
        permissions: ["pos.order.view"],
      }).reason,
      "not_owner",
    );
    assert.equal(evaluateSupportDecisionGuard(undefined).canDecide, false);
    assert.equal(
      evaluateSupportDecisionGuard({ ...owner, authenticated: false })
        .canDecide,
      false,
    );
  });
});

describe("539-U4 B: error map", () => {
  const t = (key) => key;
  test("new codes map to their own catalog text", () => {
    assert.equal(
      supportErrorMessage(
        new ApiError(409, "SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED", "x"),
        t,
      ),
      "supportAccess.errors.ownerApprovalRequired",
    );
    assert.equal(
      supportErrorMessage(
        new ApiError(403, "IMPERSONATION_NOT_ALLOWED", "x"),
        t,
      ),
      "supportAccess.errors.impersonationNotAllowed",
    );
    assert.equal(
      supportErrorMessage(new ApiError(403, "MFA_REQUIRED", "x"), t),
      "supportAccess.errors.mfa",
    );
  });
});

describe("539-U4 B: endpoint calls", () => {
  const id = "5ac0000c-0000-4000-8000-000000000001";
  test("read_write is filed on the request endpoint, not the old session one", async () => {
    await api.requestSupportWriteAccessCall("tenant-1", {
      reason: "r".repeat(20),
      durationMinutes: 30,
      mfaCode: "123456",
    });
    assert.equal(
      calls[0].endpoint.path,
      "/api/platform/tenants/:tenantId/support-access-requests",
    );
    assert.equal(calls[0].input.params.tenantId, "tenant-1");
    await api.requestSupportAccessCall("tenant-1", {
      reason: "r".repeat(20),
      durationMinutes: 60,
      accessMode: "read_only",
      mfaCode: "123456",
    });
    assert.equal(
      calls[1].endpoint.path,
      "/api/platform/tenants/:tenantId/support-access",
    );
  });

  test("approve and reject hit the owner endpoints with an empty body", async () => {
    await api.approveSupportAccessRequestCall(id);
    await api.rejectSupportAccessRequestCall(id);
    assert.equal(
      calls[0].endpoint.path,
      "/api/org/support-access/requests/:requestId/approve",
    );
    assert.equal(
      calls[1].endpoint.path,
      "/api/org/support-access/requests/:requestId/reject",
    );
    assert.deepEqual(calls[0].input, { params: { requestId: id }, body: {} });
  });

  test("the request list reads the owner endpoint", async () => {
    await api.fetchSupportAccessRequests();
    assert.equal(calls[0].endpoint.path, "/api/org/support-access/requests");
    assert.equal(calls[0].input.query.limit, 100);
  });
});
