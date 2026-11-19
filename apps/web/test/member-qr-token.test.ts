// Brief 1150: member QR token client. Pure view/countdown logic
// (features/ws08-member/qr-token.ts) and the api call requestMemberQrToken.
//
// Written from the spec (scratchpad spec-1150), not from the implementation.
// Assumptions:
//  - A valid token with `pending` true (silent re-request) stays "ready": only
//    a missing or expired token turns pending into "loading".
//  - `pending && failed` with no token resolves "loading" (spec order: pending
//    is checked first).
//  - Only the network edge `callEndpoint` is mocked; the endpoint object is the
//    real `issueMemberQrToken` from @starter/shared/crm.
import { issueMemberQrToken } from "@starter/shared/crm";
import {
  QR_TOKEN_TTL_SECONDS,
  buildQrTokenBody,
  formatCountdown,
  isQrTokenExpired,
  resolveQrTokenView,
  secondsLeft,
} from "@/features/ws08-member/qr-token";
import { requestMemberQrToken } from "@/features/ws08-member/api";
import { callEndpoint } from "@/lib/api/endpoint";

vi.mock("@/lib/api/endpoint", () => ({
  callEndpoint: vi.fn(),
}));

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const ORDER_ID = "01JCQ8Z5N0M3X4Y5Z6A7B8C9E1";

const validToken = { token: "tok-valid", expiresAt: iso(60_000) };
const expiredToken = { token: "tok-old", expiresAt: iso(-1_000) };

describe("1150 qr-token countdown", () => {
  it("token lives 120 seconds", () => {
    expect(QR_TOKEN_TTL_SECONDS).toBe(120);
  });

  it("secondsLeft counts whole seconds, rounding up", () => {
    expect(secondsLeft(iso(120_000), NOW)).toBe(120);
    expect(secondsLeft(iso(119_001), NOW)).toBe(120);
    expect(secondsLeft(iso(7_000), NOW)).toBe(7);
    expect(secondsLeft(iso(1), NOW)).toBe(1);
  });

  it("secondsLeft is 0 at, after, or with an invalid expiry", () => {
    expect(secondsLeft(iso(0), NOW)).toBe(0);
    expect(secondsLeft(iso(-5_000), NOW)).toBe(0);
    expect(secondsLeft("not-a-date", NOW)).toBe(0);
  });

  it("isQrTokenExpired is true only when no seconds are left", () => {
    expect(isQrTokenExpired(iso(1_000), NOW)).toBe(false);
    expect(isQrTokenExpired(iso(0), NOW)).toBe(true);
    expect(isQrTokenExpired(iso(-1), NOW)).toBe(true);
    expect(isQrTokenExpired("garbage", NOW)).toBe(true);
  });

  it("formatCountdown shows m:ss", () => {
    expect(formatCountdown(120)).toBe("2:00");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(7)).toBe("0:07");
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("formatCountdown clamps negative and NaN to 0:00", () => {
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
  });
});

describe("1150 qr-token view", () => {
  const base = { pending: false, failed: false, online: true, nowMs: NOW };

  it("first request in flight shows loading", () => {
    expect(resolveQrTokenView({ ...base, pending: true })).toBe("loading");
  });

  it("nothing requested yet shows loading", () => {
    expect(resolveQrTokenView({ ...base })).toBe("loading");
  });

  it("requested token shows ready", () => {
    expect(resolveQrTokenView({ ...base, token: validToken })).toBe("ready");
  });

  it("token past its expiry shows expired", () => {
    expect(resolveQrTokenView({ ...base, token: expiredToken })).toBe(
      "expired",
    );
  });

  it("re-request with an expired token shows loading", () => {
    expect(
      resolveQrTokenView({ ...base, token: expiredToken, pending: true }),
    ).toBe("loading");
  });

  it("re-request while the old token is still valid keeps ready", () => {
    expect(
      resolveQrTokenView({ ...base, token: validToken, pending: true }),
    ).toBe("ready");
  });

  it("failed request online shows error", () => {
    expect(resolveQrTokenView({ ...base, failed: true })).toBe("error");
  });

  it("failed request offline shows offline", () => {
    expect(resolveQrTokenView({ ...base, failed: true, online: false })).toBe(
      "offline",
    );
  });

  it("failed re-request after expiry shows error online, offline offline", () => {
    expect(
      resolveQrTokenView({ ...base, token: expiredToken, failed: true }),
    ).toBe("error");
    expect(
      resolveQrTokenView({
        ...base,
        token: expiredToken,
        failed: true,
        online: false,
      }),
    ).toBe("offline");
  });

  it("a still-valid token stays ready even if a refresh failed", () => {
    expect(
      resolveQrTokenView({ ...base, token: validToken, failed: true }),
    ).toBe("ready");
    expect(
      resolveQrTokenView({
        ...base,
        token: validToken,
        failed: true,
        online: false,
      }),
    ).toBe("ready");
  });

  it("token expires as time passes", () => {
    const input = { ...base, token: validToken };
    expect(resolveQrTokenView(input)).toBe("ready");
    expect(resolveQrTokenView({ ...input, nowMs: NOW + 60_000 })).toBe(
      "expired",
    );
  });
});

describe("1150 qr-token body", () => {
  it("no input gives an empty body", () => {
    expect(buildQrTokenBody()).toEqual({});
    expect(buildQrTokenBody({})).toEqual({});
  });

  it("order and points together are sent", () => {
    expect(buildQrTokenBody({ orderId: ORDER_ID, points: 50 })).toEqual({
      orderId: ORDER_ID,
      points: 50,
    });
  });

  it("only one of the two fields throws", () => {
    expect(() => buildQrTokenBody({ orderId: ORDER_ID })).toThrow(Error);
    expect(() => buildQrTokenBody({ points: 50 })).toThrow(Error);
  });
});

describe("1150 requestMemberQrToken api", () => {
  const callEndpointMock = vi.mocked(callEndpoint);
  const minted = { token: "tok-minted", expiresAt: iso(120_000) };

  beforeEach(() => {
    callEndpointMock.mockReset();
    callEndpointMock.mockResolvedValue({ data: minted } as never);
  });

  it("posts the qr-token endpoint with an empty body and unwraps data", async () => {
    const result = await requestMemberQrToken();
    expect(result).toEqual(minted);
    expect(callEndpointMock).toHaveBeenCalledTimes(1);
    const [endpoint, input] = callEndpointMock.mock.calls[0] as unknown as [
      unknown,
      { body: unknown },
    ];
    expect(endpoint).toBe(issueMemberQrToken);
    expect(input.body).toEqual({});
  });

  it("sends orderId and points when both are given", async () => {
    await requestMemberQrToken({ orderId: ORDER_ID, points: 30 });
    const input = callEndpointMock.mock.calls[0]?.[1] as unknown as {
      body: unknown;
    };
    expect(input.body).toEqual({ orderId: ORDER_ID, points: 30 });
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    await requestMemberQrToken(undefined, controller.signal);
    const options = callEndpointMock.mock.calls[0]?.[2] as unknown as {
      signal?: AbortSignal;
    };
    expect(options.signal).toBe(controller.signal);
  });

  it("propagates a failed request", async () => {
    callEndpointMock.mockRejectedValue(new Error("network down"));
    await expect(requestMemberQrToken()).rejects.toThrow("network down");
  });

  it("rejects a half-specified input before any request", async () => {
    // Sync throw or rejected promise are both fine (spec: builder throws).
    await expect(async () =>
      requestMemberQrToken({ orderId: ORDER_ID } as never),
    ).rejects.toThrow();
    expect(callEndpointMock).not.toHaveBeenCalled();
  });
});
