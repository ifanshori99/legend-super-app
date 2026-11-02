import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signDeviceToken, verifyDeviceToken } from "./device-token";

const payload = {
  version: 1 as const,
  tenantId: "11111111-1111-4111-8111-111111111111",
  brandId: null,
  deviceId: "22222222-2222-4222-8222-222222222222",
};

describe("TEN-02 signed device token", () => {
  it("verifies a token the server signed", () => {
    const token = signDeviceToken(payload);
    expect(verifyDeviceToken(token)).toEqual({
      ...payload,
      expiresAt: expect.any(Number),
    });
  });

  it("refuses a token whose signature was changed", () => {
    const token = signDeviceToken(payload);
    const index = token.lastIndexOf(".");
    const signature = token.slice(index + 1);
    const altered = `${token.slice(0, index + 1)}${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    expect(verifyDeviceToken(altered)).toBeNull();
  });

  it("refuses a token signed with another key", () => {
    const body = Buffer.from(
      JSON.stringify({ ...payload, expiresAt: 4_000_000_000 }),
      "utf8",
    ).toString("base64url");
    const signingInput = `dv1.${body}`;
    const forged = createHmac("sha256", "not-the-server-secret")
      .update(signingInput)
      .digest("base64url");
    expect(verifyDeviceToken(`${signingInput}.${forged}`)).toBeNull();
  });

  it("refuses an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signDeviceToken(payload, now - 1);
    expect(verifyDeviceToken(token)).toBeNull();
  });

  it("refuses payloads that do not parse strictly", () => {
    const body = Buffer.from(
      JSON.stringify({ ...payload, version: 2, expiresAt: 4_000_000_000 }),
      "utf8",
    ).toString("base64url");
    const signingInput = `dv1.${body}`;
    // Signed with the real key, but the payload version is wrong.
    const key = createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "")
      .update("legend.device-token.v1")
      .digest();
    const signature = createHmac("sha256", key)
      .update(signingInput)
      .digest("base64url");
    expect(verifyDeviceToken(`${signingInput}.${signature}`)).toBeNull();
  });
});
