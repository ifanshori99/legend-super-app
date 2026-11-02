// Mock handlers for the guest Wi-Fi portal (`VITE_API_MOCK=true`), so the
// screen fully works with no API (docs/frontend.md "Typed endpoints and mock
// mode"). They serve the Lmmn contract fixtures and mirror its quota engine:
// free minutes + one hour per full Rp30.000 of paid spend (FAC-12), and a
// spent quota that drops to the base speed instead of disconnecting (FAC-13).
//
// Loaded in Node by tests/ws09-wifi.test.mjs, so every import here is a bare
// package import or a relative `.ts` path (no `@/` alias). `?mock=empty` makes
// GET /api/wifi/sessions/current report "not connected" so the connect screen
// can be reviewed without a second browser profile.
import {
  cafeLegendWifiPolicies,
  cafeLegendWifiQuotaView,
  cafeLegendWifiSessions,
  getCurrentWifiSession,
  getWifiPolicyForZone,
  refreshWifiQuota,
  startWifiSession,
  wifiSessionIdSchema,
  wifiSpeedTier,
  type WifiPolicy,
  type WifiQuotaView,
  type WifiSession,
} from "@starter/shared/facility";
import { ApiError } from "../../lib/api/errors.ts";
import "../../lib/mock/handlers/subscription-plans.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { dailyQuotaMinutes } from "./state.ts";

/** Server clock the mock reports; the fixture instant keeps screenshots stable. */
const SERVER_TIME = cafeLegendWifiQuotaView.serverTime;

const seed = cafeLegendWifiSessions[0];

/**
 * One account's day at the venue: its device sessions and the paid F&B spend
 * the daily allowance is derived from. The BE engine (bead legend-kmd3) shares
 * one allowance per account; the mock keeps one running session per device
 * with the same allowance, which is what the portal has to render.
 */
type WifiMockState = {
  sessions: WifiSession[];
  sameDaySpendIdr: number;
  /** True once the guest pressed "Sambungkan Wi-Fi" in this page load. */
  connected: boolean;
};

const store = createMockStore<WifiMockState>(() => ({
  sessions: [seed],
  // The fixture session carries 2 free hours + 3 hours from Rp90.000 of spend.
  sameDaySpendIdr: 90_000,
  connected: false,
}));

function policyForZone(zoneId: string): WifiPolicy {
  const policy = cafeLegendWifiPolicies.find(
    (candidate) => candidate.zoneId === zoneId,
  );
  if (!policy)
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Kebijakan Wi-Fi untuk zona ini belum diatur.",
    );
  return policy;
}

function policyOf(session: WifiSession): WifiPolicy {
  const policy = cafeLegendWifiPolicies.find(
    (candidate) => candidate.id === session.policyId,
  );
  if (!policy)
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Kebijakan Wi-Fi sesi ini tidak ditemukan.",
    );
  return policy;
}

/**
 * The speed tier is derived, never stored as an input: a session that spends
 * its quota keeps running at the base speed (FAC-13).
 */
function deriveTier(session: WifiSession): WifiSession {
  return {
    ...session,
    speedTier: wifiSpeedTier(session.usedMinutes, session.quotaMinutes),
  };
}

function quotaView(session: WifiSession): WifiQuotaView {
  const current = deriveTier(session);
  return {
    session: current,
    policy: policyOf(current),
    remainingMinutes: Math.max(0, current.quotaMinutes - current.usedMinutes),
    serverTime: SERVER_TIME,
  };
}

async function deviceDigest(fingerprint: string): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprint);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Apply a cumulative daily spend the way the BE quota engine does (FAC-12). */
function applySpend(sameDaySpendIdr: number) {
  const state = store.get();
  const spend = Math.max(state.sameDaySpendIdr, sameDaySpendIdr);
  const sessions = recomputeSessions(state, spend);
  store.set({ ...state, sameDaySpendIdr: spend, sessions });
  return sessions;
}

/**
 * Recompute every active session from the day's spend the mock already holds.
 * FAC-12: the spend comes from the mock's settled-payment state
 * (`wifiMockControl.pay`), never from the refresh request body.
 */
function recomputeSessions(
  state: WifiMockState,
  sameDaySpendIdr: number,
): WifiSession[] {
  return state.sessions.map((session) =>
    session.endedAt === null
      ? deriveTier({
          ...session,
          quotaMinutes: dailyQuotaMinutes(policyOf(session), {
            isPeak: false,
            sameDaySpendIdr,
          }),
        })
      : session,
  );
}

/**
 * Mock-only controls for demos and the Playwright spec (the whole mock runtime
 * is compiled out of production builds): a paid order adding quota, and sitting
 * on the network until the quota is spent.
 */
export const wifiMockControl = {
  /** Simulates a paid F&B order landing on the account. */
  pay(sameDaySpendIdr: number) {
    applySpend(sameDaySpendIdr);
  },
  /** Simulates minutes of usage on the current device. */
  consume(usedMinutes: number) {
    const state = store.get();
    store.set({
      ...state,
      sessions: state.sessions.map((session) =>
        session.endedAt === null
          ? deriveTier({ ...session, usedMinutes })
          : session,
      ),
    });
  },
};

type WifiMockWindow = {
  __legendWifiMock?: typeof wifiMockControl;
};

if (typeof window !== "undefined")
  (window as unknown as WifiMockWindow).__legendWifiMock = wifiMockControl;

registerMock(getWifiPolicyForZone, ({ query }) => ({
  data: policyForZone(query.zoneId),
}));

registerMock(getCurrentWifiSession, ({ scenario }) => {
  // `?mock=empty` shows "not connected" until the guest connects; after that
  // the session exists like in any other scenario.
  if (scenario === "empty" && !store.get().connected) return { data: null };
  const active = store
    .get()
    .sessions.find((session) => session.endedAt === null);
  return { data: active ? quotaView(active) : null };
});

registerMock(startWifiSession, async ({ body, scenario }) => {
  const policy = policyForZone(body.zoneId);
  // `?mock=empty` means a guest with no session yet: the fixture's running
  // session is not theirs, so connecting starts a fresh one (0 minutes used).
  const base = store.get();
  const state =
    scenario === "empty" && !base.connected ? { ...base, sessions: [] } : base;
  const digest = await deviceDigest(body.deviceFingerprint);
  const existing = state.sessions.find(
    (session) => session.deviceHash === digest,
  );
  if (existing) {
    store.set({ ...state, connected: true });
    return { data: quotaView(existing) };
  }

  const activeDevices = state.sessions.filter(
    (session) => session.endedAt === null,
  ).length;
  if (activeDevices >= policy.maxDevices)
    throw new ApiError(
      409,
      "WIFI_DEVICE_LIMIT",
      "Jumlah perangkat untuk akun ini sudah mencapai batas. Putuskan salah satu perangkat.",
    );

  const session: WifiSession = {
    ...seed,
    id: wifiSessionIdSchema.parse(crypto.randomUUID()),
    zoneId: policy.zoneId,
    policyId: policy.id,
    deviceHash: digest,
    quotaMinutes: dailyQuotaMinutes(policy, {
      isPeak: false,
      sameDaySpendIdr: state.sameDaySpendIdr,
    }),
    usedMinutes: 0,
    speedTier: "full",
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  store.set({
    ...state,
    sessions: [...state.sessions, session],
    connected: true,
  });
  return { data: quotaView(session) };
});

// FAC-12: the request body is empty (the mock runtime validates it), and the
// spend is the one the mock's settled payments already recorded.
registerMock(refreshWifiQuota, () => {
  const state = store.get();
  const active = state.sessions.find((session) => session.endedAt === null);
  if (!active)
    throw new ApiError(409, "CONFLICT", "Belum ada sesi Wi-Fi yang aktif.");
  const sessions = recomputeSessions(state, state.sameDaySpendIdr);
  store.set({ ...state, sessions });
  const updated = sessions.find((session) => session.id === active.id);
  return { data: quotaView(updated ?? active) };
});
