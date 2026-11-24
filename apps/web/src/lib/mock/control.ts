// Scenario and fault controls for mock mode. FE threads use them to see the
// loading, empty and error states of a screen without a backend (and to take
// the screenshots the quality gate asks for):
//   ?mock=empty            (URL, remembered in localStorage["legend-mock-scenario"])
//   window.__legendMock.setScenario("slow" | "error" | "offline" | "empty" | "normal")
//   window.__legendMock.failNext("GET /api/example/outlets", { status: 409, code: "CONFLICT" })
// Pure TypeScript: loadable in Node for tests; browser hooks are guarded.

export const MOCK_SCENARIOS = [
  "normal",
  "empty",
  "slow",
  "error",
  "offline",
  "resolved-evidence-mismatch",
  /**
   * legend-qf0i: the demo catalogue gives every item a photo, so the pre-Q23
   * "active item without a photo" case needs its own scenario. It adds one
   * legacy row (`legacyPhotoMissingItem` in the menu fixtures): the back office
   * lists it with the "Foto wajib" badge and refuses to publish it, and every
   * guest read hides it.
   */
  "photo-missing",
  /** legend-vnvg: the signed-in member has no verified WhatsApp number yet. */
  "wa-unverified",
  /** legend-vnvg: the identity fixture view with its WhatsApp number verified. */
  "wa-verified",
  /** legend-vnvg: unverified WhatsApp and an empty point ledger. */
  "wa-unverified-empty",
  /**
   * legend-46vt: the QR bill's point claim is "available" but the guest has no
   * account (`requiresLogin`), so the claim card shows its /masuk sign-in CTA.
   */
  "claim-login",
  /**
   * legend-0ne0z (member "tukar poin di kasir"): the first points-redeem status
   * check reports the cashier scanned the QR; balance and bill follow.
   */
  "points-consumed",
  /** legend-0ne0z: the open bill already has 500 poin (Rp50.000) redeemed. */
  "points-redeemed",
  /** legend-0ne0z: bills and quote load, minting the QR fails with 503. */
  "points-mint-fail",
  /** legend-0ne0z: two open bills (LG-0248 Kemang, LG-0251 Senopati). */
  "points-multi-bill",
  /**
   * Card 1263: closing November is refused (422 PERIOD_INVENTORY_GL_BLOCKED)
   * for three incomplete production batches; the owner may close over them
   * with a written reason. Business date of the close is 2026-12-05.
   */
  "period-close-blocked",
  /** Card 1263: the refusal also lists a source no reason can close over. */
  "period-close-blocked-other",
  /** Card 1263: refused once, but the list is empty when the dialog reads it. */
  "period-close-blocked-cleared",
  /** Card 1263: the first close with a reason is refused for MFA (403). */
  "period-close-blocked-mfa",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const SCENARIO_STORAGE_KEY = "legend-mock-scenario";
export const SLOW_LATENCY_MS = 3000;

export type MockFailure = {
  status: number;
  code: string;
  message?: string;
};
type QueuedFailure = MockFailure & { match: string };

type ControlState = {
  scenario: MockScenario;
  latencyMs: number;
  failures: QueuedFailure[];
};

const defaults = (): ControlState => ({
  scenario: "normal",
  latencyMs: 0,
  failures: [],
});
let state = defaults();

export function isMockScenario(value: unknown): value is MockScenario {
  return (MOCK_SCENARIOS as readonly unknown[]).includes(value);
}

export function getScenario(): MockScenario {
  return state.scenario;
}
export function setScenario(scenario: MockScenario) {
  state.scenario = scenario;
  const storage = browserStorage();
  try {
    if (scenario === "normal") storage?.removeItem(SCENARIO_STORAGE_KEY);
    else storage?.setItem(SCENARIO_STORAGE_KEY, scenario);
  } catch {
    // Storage can be blocked; the scenario still applies for this page.
  }
}

/** Base latency of every mock call (the "slow" scenario uses SLOW_LATENCY_MS). */
export function getLatencyMs(): number {
  return state.scenario === "slow" ? SLOW_LATENCY_MS : state.latencyMs;
}
export function setLatencyMs(latencyMs: number) {
  state.latencyMs = Math.max(0, latencyMs);
}

/** Fail the next call to `match` (an endpoint id like "GET /api/x", or "*"). */
export function failNext(match: string, failure: MockFailure) {
  state.failures.push({ match, ...failure });
}
export function takeFailure(endpointId: string): MockFailure | undefined {
  const index = state.failures.findIndex(
    (item) => item.match === "*" || item.match === endpointId,
  );
  if (index === -1) return undefined;
  return state.failures.splice(index, 1)[0];
}

export function resetControl() {
  state = defaults();
}

type BrowserLike = {
  location?: { search: string };
  localStorage?: Storage;
  __legendMock?: unknown;
};
function browser(): BrowserLike | undefined {
  const scope = globalThis as unknown as { window?: BrowserLike };
  return scope.window;
}
function browserStorage(): Storage | undefined {
  try {
    return browser()?.localStorage;
  } catch {
    return undefined;
  }
}

/** Reads ?mock= / localStorage once and exposes window.__legendMock. */
export function installBrowserControl(extra: { reset: () => void }) {
  const win = browser();
  if (!win) return;
  let initial: unknown;
  try {
    initial =
      new URLSearchParams(win.location?.search ?? "").get("mock") ??
      browserStorage()?.getItem(SCENARIO_STORAGE_KEY);
  } catch {
    initial = undefined;
  }
  if (isMockScenario(initial)) setScenario(initial);
  win.__legendMock = {
    scenarios: MOCK_SCENARIOS,
    getScenario,
    setScenario,
    setLatencyMs,
    failNext,
    reset: extra.reset,
  };
}
