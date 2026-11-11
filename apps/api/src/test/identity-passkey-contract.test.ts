// Contract for staff passkey (WebAuthn) MFA, legend-jemg. Pure schema checks on
// the shared identity contract (PRD v1.7 §3 F6 "Staf — Login Web", §6 B
// `mfa_factors` type totp|passkey with public_key). No database used.
//
// Assumptions (the brief leaves the wire shape open; the engineer must match):
//  - POST /api/auth/mfa/verify keeps `{ factorId, code }` for TOTP and gains two
//    mutually exclusive shapes carrying WebAuthn JSON responses:
//      { factorId, attestation }  finishes passkey enrollment
//      { factorId, assertion }    verifies the session with an enrolled passkey
//    `attestation` is RegistrationResponseJSON, `assertion` AuthenticationResponseJSON.
//  - A new endpoint `requestMfaChallenge` = POST /api/auth/mfa/factors/:factorId/challenge
//    (no body) issues the authentication options for the session.
//  - Tenant keys are still forbidden from the client (TEN-02): strict objects.

import { describe, expect, it } from "vitest";
import {
  enrollMfaFactor,
  mfaVerifySchema,
  requestMfaChallenge,
  verifyMfaFactor,
} from "@starter/shared/identity";

const FACTOR_ID = "6f1d3c1e-2b0a-4f43-9d55-0b1d2f7a9c10";

const assertion = {
  id: "Y3JlZC1pZA",
  rawId: "Y3JlZC1pZA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AAAA",
    signature: "MEUC",
  },
  clientExtensionResults: {},
};

const attestation = {
  id: "Y3JlZC1pZA",
  rawId: "Y3JlZC1pZA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    attestationObject: "o2NmbXRkbm9uZQ",
    transports: ["internal"],
  },
  clientExtensionResults: {},
};

describe("MFA passkey contract (legend-jemg)", () => {
  it("jemg: verify still accepts a six-digit TOTP code", () => {
    expect(
      mfaVerifySchema.safeParse({ factorId: FACTOR_ID, code: "123456" })
        .success,
    ).toBe(true);
  });

  it("jemg: verify still rejects a code that is not six digits", () => {
    for (const code of ["12345", "1234567", "12345a", ""])
      expect(
        mfaVerifySchema.safeParse({ factorId: FACTOR_ID, code }).success,
      ).toBe(false);
  });

  it("jemg: verify accepts a passkey assertion payload", () => {
    const parsed = mfaVerifySchema.safeParse({
      factorId: FACTOR_ID,
      assertion,
    });
    expect(parsed.success).toBe(true);
  });

  it("jemg: verify accepts a passkey attestation payload to finish enrollment", () => {
    const parsed = mfaVerifySchema.safeParse({
      factorId: FACTOR_ID,
      attestation,
    });
    expect(parsed.success).toBe(true);
  });

  it("jemg: verify rejects an assertion missing its signature or client data", () => {
    for (const missing of [
      "signature",
      "clientDataJSON",
      "authenticatorData",
    ]) {
      const response = { ...assertion.response } as Record<string, unknown>;
      delete response[missing];
      expect(
        mfaVerifySchema.safeParse({
          factorId: FACTOR_ID,
          assertion: { ...assertion, response },
        }).success,
      ).toBe(false);
    }
  });

  it("jemg: verify rejects a body that mixes a code with a passkey payload", () => {
    expect(
      mfaVerifySchema.safeParse({
        factorId: FACTOR_ID,
        code: "123456",
        assertion,
      }).success,
    ).toBe(false);
    expect(
      mfaVerifySchema.safeParse({
        factorId: FACTOR_ID,
        assertion,
        attestation,
      }).success,
    ).toBe(false);
  });

  it("jemg: verify rejects a body with neither code nor passkey payload", () => {
    expect(mfaVerifySchema.safeParse({ factorId: FACTOR_ID }).success).toBe(
      false,
    );
  });

  it("jemg: verify never accepts a tenant id from the client (TEN-02)", () => {
    expect(
      mfaVerifySchema.safeParse({
        factorId: FACTOR_ID,
        assertion,
        tenantId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });

  it("jemg: verify rejects a non-uuid factor id on the passkey shape", () => {
    expect(
      mfaVerifySchema.safeParse({ factorId: "nope", assertion }).success,
    ).toBe(false);
  });

  it("jemg: the challenge endpoint is declared next to enroll and verify", () => {
    expect(requestMfaChallenge.method).toBe("POST");
    expect(requestMfaChallenge.path).toBe(
      "/api/auth/mfa/factors/:factorId/challenge",
    );
    expect(enrollMfaFactor.path).toBe("/api/auth/mfa/factors");
    expect(verifyMfaFactor.path).toBe("/api/auth/mfa/verify");
  });

  it("jemg: the enroll response schema accepts passkey creation options", () => {
    const parsed = enrollMfaFactor.response.safeParse({
      data: {
        type: "passkey",
        factorId: FACTOR_ID,
        publicKeyOptions: { challenge: "Y2hhbGxlbmdl", rp: { name: "Legend" } },
      },
    });
    expect(parsed.success).toBe(true);
  });
});
