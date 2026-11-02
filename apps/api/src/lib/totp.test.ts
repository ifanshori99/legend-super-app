import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpOtpauthUri,
  totpStep,
  verifyTotpCode,
} from "./totp";

// RFC 4226 Appendix D (same secret as RFC 6238): HOTP counters 0..9.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_CODES = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

describe("TOTP (RFC 4226/6238)", () => {
  it("matches the RFC 4226 test vectors", () => {
    RFC_CODES.forEach((code, counter) => {
      expect(totpCode(RFC_SECRET, counter)).toBe(code);
    });
  });

  it("round-trips base32 and mints a 160-bit secret", () => {
    expect(base32Decode(base32Encode(Buffer.from("Legend!"))).toString()).toBe(
      "Legend!",
    );
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("derives the step from the clock (30-second period)", () => {
    expect(totpStep(new Date("2026-11-02T00:00:00.000Z"))).toBe(
      Math.floor(Date.parse("2026-11-02T00:00:00.000Z") / 1000 / 30),
    );
  });

  it("accepts one step of clock skew and rejects a code already used", () => {
    const now = new Date("2026-11-02T10:00:15.000Z");
    const step = totpStep(now);
    const previous = totpCode(RFC_SECRET, step - 1);
    expect(
      verifyTotpCode({ secretBase32: RFC_SECRET, code: previous, now }),
    ).toBe(step - 1);
    // One step behind is inside the ±1 window; at or below lastUsedStep is not.
    expect(
      verifyTotpCode({
        secretBase32: RFC_SECRET,
        code: previous,
        now,
        lastUsedStep: step - 1,
      }),
    ).toBeNull();
    // Two steps behind is outside the window.
    expect(
      verifyTotpCode({
        secretBase32: RFC_SECRET,
        code: totpCode(RFC_SECRET, step - 2),
        now,
      }),
    ).toBeNull();
  });

  it("builds an otpauth URI an authenticator app can scan", () => {
    const uri = totpOtpauthUri({
      secretBase32: RFC_SECRET,
      accountName: "kasir@example.com",
      issuer: "Legend",
    });
    expect(uri.startsWith("otpauth://totp/Legend%3Akasir%40example.com?")).toBe(
      true,
    );
    const params = new URL(uri.replace("otpauth://", "https://")).searchParams;
    expect(params.get("secret")).toBe(RFC_SECRET);
    expect(params.get("issuer")).toBe("Legend");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });
});
