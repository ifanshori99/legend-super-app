import { describe, expect, it } from "vitest";
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "./mfa-recovery-code";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

describe("MFA recovery codes", () => {
  it("generates XXXXX-XXXXX codes from the Crockford alphabet", () => {
    for (let i = 0; i < 200; i += 1)
      expect(generateRecoveryCode()).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/,
      );
  });

  it("does not repeat across a batch", () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => generateRecoveryCode()),
    );
    expect(codes.size).toBe(200);
  });

  it("normalizes whitespace, dashes and case", () => {
    expect(normalizeRecoveryCode(" ab3de-fgh7j ")).toBe("AB3DEFGH7J");
    expect(normalizeRecoveryCode("AB3DE FGH7J")).toBe("AB3DEFGH7J");
    expect(normalizeRecoveryCode("ab3defgh7j")).toBe("AB3DEFGH7J");
  });

  it("hashes to a stable keyed hex digest bound to the user", () => {
    const hash = recoveryCodeHash(USER_A, "AB3DEFGH7J");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveryCodeHash(USER_A, "AB3DEFGH7J")).toBe(hash);
    expect(recoveryCodeHash(USER_B, "AB3DEFGH7J")).not.toBe(hash);
    expect(recoveryCodeHash(USER_A, "AB3DEFGH7K")).not.toBe(hash);
    expect(hash).not.toContain("AB3DEFGH7J");
  });
});
