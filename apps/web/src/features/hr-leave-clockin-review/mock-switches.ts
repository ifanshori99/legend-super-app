// Mock-mode switch the screens' permission hook reads (bead legend-3jem1).
// Pure and browser-guarded (no `import.meta`), so hooks.ts can import it
// without pulling the mock handlers into a production bundle; the handlers
// themselves live in mock.ts, which only the mock runtime loads.
//
// No role template holds hr.attendance.manage without hr.leave.approve, so the
// "tanpa hak membatalkan" state needs its own switch. Turn it on with
//   ?leaveRights=keep-only   (URL, remembered in localStorage)
//   localStorage["legend-mock-leave-rights"] = "keep-only"
// and off with ?leaveRights=full. It only changes what the mock reports;
// real access still comes from the session.

export const MOCK_LEAVE_RIGHTS_KEY = "legend-mock-leave-rights";
export const MOCK_LEAVE_RIGHTS_PARAM = "leaveRights";

type BrowserLike = { location?: { search: string }; localStorage?: Storage };

/** True when the mock should behave like a reviewer who can only keep leave. */
export function mockLeaveKeepOnly(): boolean {
  const win = (globalThis as unknown as { window?: BrowserLike }).window;
  if (!win) return false;
  try {
    const fromUrl = new URLSearchParams(win.location?.search ?? "").get(
      MOCK_LEAVE_RIGHTS_PARAM,
    );
    if (fromUrl === "keep-only" || fromUrl === "full") {
      if (fromUrl === "keep-only")
        win.localStorage?.setItem(MOCK_LEAVE_RIGHTS_KEY, "keep-only");
      else win.localStorage?.removeItem(MOCK_LEAVE_RIGHTS_KEY);
      return fromUrl === "keep-only";
    }
    return win.localStorage?.getItem(MOCK_LEAVE_RIGHTS_KEY) === "keep-only";
  } catch {
    return false;
  }
}
