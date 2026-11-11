// Split bill claim contract (bead legend-ms3): splitClaimSchema and the
// getSplitClaim endpoint.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  pathParamNames,
} from "../packages/shared/src/api/endpoint.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";

const splitId = "00000000-0000-4000-8000-000000000501";
const sessionId = "00000000-0000-4000-8000-000000000502";
const until = "2026-11-11T10:00:00.000Z";

test("splitClaimSchema accepts every status in its valid shape", () => {
  for (const status of ["unavailable", "claimed", "expired"]) {
    assert.ok(
      qr.splitClaimSchema.safeParse({
        billSplitId: splitId,
        status,
        claimToken: null,
        claimableUntil: null,
      }).success,
      status,
    );
  }
  assert.ok(
    qr.splitClaimSchema.safeParse({
      billSplitId: splitId,
      status: "available",
      claimToken: "sc_abc",
      claimableUntil: until,
    }).success,
  );
});

test("splitClaimSchema: available needs a token and a deadline", () => {
  for (const patch of [{ claimToken: null }, { claimableUntil: null }]) {
    assert.equal(
      qr.splitClaimSchema.safeParse({
        billSplitId: splitId,
        status: "available",
        claimToken: "sc_abc",
        claimableUntil: until,
        ...patch,
      }).success,
      false,
      JSON.stringify(patch),
    );
  }
});

test("splitClaimSchema is strict and rejects unknown status or extra keys", () => {
  const base = {
    billSplitId: splitId,
    status: "unavailable",
    claimToken: null,
    claimableUntil: null,
  };
  assert.equal(
    qr.splitClaimSchema.safeParse({ ...base, extra: 1 }).success,
    false,
  );
  assert.equal(
    qr.splitClaimSchema.safeParse({ ...base, status: "pending" }).success,
    false,
  );
  assert.equal(
    qr.splitClaimSchema.safeParse({ ...base, billSplitId: "nope" }).success,
    false,
  );
});

test("getSplitClaim is POST /api/table-sessions/:sessionId/splits/:splitId/claim", () => {
  assert.equal(qr.getSplitClaim.method, "POST");
  assert.equal(
    qr.getSplitClaim.path,
    "/api/table-sessions/:sessionId/splits/:splitId/claim",
  );
  assert.deepEqual(
    Object.keys(qr.getSplitClaim.params.shape).sort(),
    [...pathParamNames(qr.getSplitClaim.path)].sort(),
  );
  assert.equal(
    buildEndpointPath(qr.getSplitClaim.path, { sessionId, splitId }),
    `/api/table-sessions/${sessionId}/splits/${splitId}/claim`,
  );
});
