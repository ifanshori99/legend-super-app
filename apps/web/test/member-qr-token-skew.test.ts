// Brief 1150 review fix: the countdown must not depend on the phone clock
// matching the server clock, so expiry is counted from the receive time.
import {
  QR_TOKEN_TTL_SECONDS,
  localExpiry,
  resolveQrTokenView,
  secondsLeft,
} from "@/features/ws08-member/qr-token";

const RECEIVED = Date.parse("2026-11-19T10:00:00.000Z");

describe("1150 qr-token local expiry", () => {
  it("expires exactly one TTL after the receive time", () => {
    expect(localExpiry(RECEIVED)).toBe(
      new Date(RECEIVED + QR_TOKEN_TTL_SECONDS * 1000).toISOString(),
    );
    expect(secondsLeft(localExpiry(RECEIVED), RECEIVED)).toBe(120);
  });

  it("a phone clock 3 minutes ahead of the server still shows a fresh token as ready", () => {
    // Server expiresAt would already be 3 min in the past for this phone.
    const serverExpiresAt = new Date(
      RECEIVED - 3 * 60_000 + 120_000,
    ).toISOString();
    const token = { token: "t", expiresAt: localExpiry(RECEIVED) };
    const view = (expiresAt: string) =>
      resolveQrTokenView({
        token: { token: "t", expiresAt },
        pending: false,
        failed: false,
        online: true,
        nowMs: RECEIVED + 1_000,
      });
    expect(view(serverExpiresAt)).toBe("expired");
    expect(view(token.expiresAt)).toBe("ready");
  });

  it("turns expired once the TTL has passed since receipt", () => {
    const token = { token: "t", expiresAt: localExpiry(RECEIVED) };
    expect(
      resolveQrTokenView({
        token,
        pending: false,
        failed: false,
        online: true,
        nowMs: RECEIVED + 121_000,
      }),
    ).toBe("expired");
  });
});
