// O5 follow-up (Keputusan CTO 27 Nov, point 6 b and c): the close screen on a
// tablet without internet.
// - (c) the blind count is written to the cloud, so while the tablet cannot
//   reach the API the screen says "Tutup shift butuh internet" and holds the
//   action (no count form, nothing to submit): strict money rule.
// - (b) when the shift read fails at the network, the screen does not crash
//   or show a generic error: the last shift status kept on the tablet (the
//   offline kit of the open shift) decides, and it holds the same way.
import { ApiError } from "@/lib/api/errors";
import {
  closeScreenMode,
  isNetworkFailure,
} from "@/features/ws04-pos-kasir/offline/close-gate";

const KIT = { shiftId: "0a1b2c3d-0000-4000-8000-0000000000b1" };
const NETWORK = new ApiError(0, "NETWORK_ERROR", "no network");

describe("closeScreenMode", () => {
  it("holds the close while the API is unreachable", () => {
    expect(closeScreenMode({ online: false, shiftError: null, kit: KIT })).toBe(
      "needs_internet",
    );
    expect(
      closeScreenMode({ online: false, shiftError: null, kit: null }),
    ).toBe("needs_internet");
  });

  it("holds the close when the shift read failed at the network and a local shift is known", () => {
    expect(
      closeScreenMode({ online: true, shiftError: NETWORK, kit: KIT }),
    ).toBe("needs_internet");
  });

  it("keeps the normal flow online", () => {
    expect(closeScreenMode({ online: true, shiftError: null, kit: KIT })).toBe(
      "normal",
    );
  });

  it("does not hide a real server error behind the offline screen", () => {
    const server = new ApiError(500, "INTERNAL", "boom");
    expect(
      closeScreenMode({ online: true, shiftError: server, kit: KIT }),
    ).toBe("normal");
  });

  it("a network failure with no local shift stays a normal error", () => {
    expect(
      closeScreenMode({ online: true, shiftError: NETWORK, kit: null }),
    ).toBe("normal");
  });
});

describe("isNetworkFailure", () => {
  it("recognises the client's network error and a fetch TypeError only", () => {
    expect(isNetworkFailure(NETWORK)).toBe(true);
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new ApiError(403, "FORBIDDEN", "no"))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});
