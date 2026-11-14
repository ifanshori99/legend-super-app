// Mock handlers for the staff second-factor and device-session endpoints
// (VITE_API_MOCK=true). The screens therefore work end to end without an API:
// fixtures come from @starter/shared/identity and every response is validated
// by the runtime against the schema the real API will use.
//
// Demo state:
//   normal            an owner session that owes the second factor; two devices
//   ?mock=empty       no factor enrolled (enrollment) and no device sessions
//   ?mock=error       every call fails (see lib/mock/control.ts)
//
// A mock-only knob shows the idle warning without waiting 28 minutes:
//   localStorage["legend-mock-session"] = "idle"  → current session ends in 2m;
//   the deadline is seeded once and never moves on a /me read: GET /api/auth/me
//   is exempt from session activity (legend-91i), so refetching it cannot
//   extend the session
//   localStorage.removeItem("legend-mock-session")
//
// Verification accepts any six digits except 000000 (wrong-code state).
// Recovery codes: the seeded set is the mockup's (ABCDE-FGHJK, ...), the first
// code is used once; a wrong code is 401 MFA_RECOVERY_CODE_INVALID, and five
// wrong codes lock with 429 like the API.
import {
  cafeLegendIdentityFixtures,
  deleteMfaFactor,
  enrollMfaFactor,
  extendCurrentSession,
  generateMfaRecoveryCodes,
  getMfaRecoveryStatus,
  listMfaFactors,
  listPushDevices,
  listSessions,
  MANAGEMENT_IDLE_MINUTES,
  mfaFactorIdSchema,
  mfaFactorSchema,
  MINUTE_MS,
  pushDeviceSchema,
  recordSessionActivity,
  revokePushDevice,
  revokeSession,
  sessionSchema,
  sessionViewSchema,
  verifyMfaFactor,
  verifyMfaRecoveryCode,
  MFA_RECOVERY_CODE_COUNT,
  type MfaEnrollment,
  type MfaFactor,
  type PushDevice,
  type Session,
  type SessionView,
} from "@starter/shared/identity";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

/** Mock-only knob for the idle warning; ignored in a real build. */
export const MOCK_SESSION_KNOB = "legend-mock-session";

type PendingFactor = { enrollment: MfaEnrollment; factor: MfaFactor };

/** The idle knob's session; seeded once so every read sees the same deadline. */
type IdleDemo = {
  expiresAt: string;
  lastSeenAt: string;
};

type RecoveryDemo = {
  /** Unused codes; empty before the first generate. */
  codes: string[];
  generatedAt: string | null;
  failed: number;
};

type AuthMockState = {
  recovery: RecoveryDemo;
  factors: MfaFactor[];
  sessions: SessionView[];
  pushDevices: PushDevice[];
  pending: Map<string, PendingFactor>;
  idle: IdleDemo | null;
};

const now = () => Date.now();
const at = (offsetMs: number) => new Date(now() + offsetMs).toISOString();

function idleKnobOn(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage?.getItem(MOCK_SESSION_KNOB) === "idle";
  } catch {
    return false;
  }
}

/** The two owner devices with a live clock, so a demo always has a session. */
function seedSessions(): SessionView[] {
  const base = cafeLegendIdentityFixtures;
  const owner = base.usersByKey.owner;
  const devices = base.sessions.filter((row) => row.userId === owner.id);
  const [current, other] = devices;
  if (!current || !other)
    throw new Error("Identity fixtures lost owner sessions");

  const currentSession = sessionSchema.parse({
    ...current,
    createdAt: at(-48 * 60_000),
    lastSeenAt: at(-60_000),
    expiresAt: at(22 * 60_000),
    mfaVerifiedAt: null, // AUTH-05 demo: the factor is still owed
  });
  const otherSession = sessionSchema.parse({
    ...other,
    createdAt: at(-2 * 60 * 60_000),
    lastSeenAt: at(-25 * 60_000),
    expiresAt: at(5 * 60_000),
    mfaVerifiedAt: at(-2 * 60 * 60_000),
  });
  return [
    sessionViewSchema.parse({ session: currentSession, current: true }),
    sessionViewSchema.parse({ session: otherSession, current: false }),
  ];
}

/** One live phone and one whose session already ended (still gets alarms). */
function seedPushDevices(): PushDevice[] {
  return [
    pushDeviceSchema.parse({
      id: "6f0c2a1e-5b7d-4c3a-9e11-2d4f8a6b0c01",
      deviceLabel: "Chrome di iPhone",
      registeredAt: at(-2 * 24 * 60 * MINUTE_MS),
      sessionActive: true,
      current: true,
    }),
    pushDeviceSchema.parse({
      id: "6f0c2a1e-5b7d-4c3a-9e11-2d4f8a6b0c02",
      deviceLabel: null,
      registeredAt: at(-20 * 24 * 60 * MINUTE_MS),
      sessionActive: false,
      current: false,
    }),
  ];
}

/** The mockup's sample set; the owner's seeded factor already has one. */
const SEED_RECOVERY_CODES = [
  "ABCDE-FGHJK",
  "MNPQR-STVWX",
  "YZ234-56789",
  "BCDFG-HJKMN",
  "PQRST-VWXYZ",
  "23456-789AB",
  "CDFGH-JKMNP",
  "QRSTV-WXYZ2",
  "34567-89ABC",
  "DFGHJ-KMNPQ",
];
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_LOCK_AFTER = 5;

function randomRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < MFA_RECOVERY_CODE_COUNT) {
    const chars = Array.from(
      { length: 10 },
      () => CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)],
    );
    codes.add(`${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`);
  }
  return [...codes];
}

const seed = (): AuthMockState => ({
  recovery: {
    codes: [...SEED_RECOVERY_CODES],
    generatedAt: at(-3 * 24 * 60 * MINUTE_MS),
    failed: 0,
  },
  factors: cafeLegendIdentityFixtures.mfaFactors.filter(
    (row) => row.userId === cafeLegendIdentityFixtures.usersByKey.owner.id,
  ),
  sessions: seedSessions(),
  pushDevices: seedPushDevices(),
  pending: new Map(),
  idle: null,
});

const state = createMockStore<AuthMockState>(seed);

/**
 * The idle knob's demo deadline, seeded once per mock session and kept in the
 * store (bead legend-dw4d). Recomputing `now + 110s` on every fetch made the
 * deadline a moving target: the warning's dismissal could never match it, so
 * the dialog reopened after every refetch.
 */
function idleDeadline(): IdleDemo {
  const auth = state.get();
  if (auth.idle !== null) return auth.idle;
  const expiresAt = at(110_000);
  auth.idle = {
    expiresAt,
    // A management session's deadline is lastSeenAt + 30 minutes (§3 F6), so
    // the demo starts from a genuinely idle session.
    lastSeenAt: new Date(
      Date.parse(expiresAt) - MANAGEMENT_IDLE_MINUTES * MINUTE_MS,
    ).toISOString(),
  };
  return auth.idle;
}

/**
 * The current session as the idle knob presents it. Reads (/me, the device
 * list) only display the demo deadline; none of them counts as activity
 * (GET /api/auth/me is exempt from session activity, legend-91i).
 */
function withIdleKnob(session: Session): Session {
  if (!idleKnobOn()) {
    state.get().idle = null; // leaving the demo starts a fresh one
    return session;
  }
  const demo = idleDeadline();
  return { ...session, lastSeenAt: demo.lastSeenAt, expiresAt: demo.expiresAt };
}

function currentSession(): Session {
  const view = state.get().sessions.find((row) => row.current);
  if (!view)
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "Sesi tidak ditemukan. Masuk kembali.",
    );
  return withIdleKnob(view.session);
}

function findFactor(factorId: string): MfaFactor {
  const factor = state.get().factors.find((row) => row.id === factorId);
  if (!factor)
    throw new ApiError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");
  return factor;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 160-bit base32 secret, the shape `totpEnrollmentSchema` requires. */
function totpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => BASE32[byte % 32]).join("");
}

/**
 * The staff side of GET /api/auth/me (owner owing a second factor). Exported
 * for lib/mock/handlers/current-auth.ts, which arbitrates with the customer
 * sign-in mock of the same endpoint.
 */
export function staffCurrentAuthMock({ scenario }: { scenario: string }) {
  const error = globalThis.localStorage?.getItem("legend-mock-auth-error");
  if (error === "401" || error === "503")
    throw new ApiError(
      Number(error),
      "MOCK_ERROR",
      "Mock session read failed.",
    );
  const base = cafeLegendIdentityFixtures;
  const owner = base.usersByKey.owner;
  const auth = state.get();
  const factors = scenario === "empty" ? [] : auth.factors;
  return {
    data: {
      user: owner,
      identities: base.identities.filter((row) => row.userId === owner.id),
      mfaFactors: factors,
      session: currentSession(),
      mfaRequired: owner.mfaRequired,
      mfaEnrollmentRequired: owner.mfaRequired && factors.length === 0,
      whatsAppVerified: base.identities.some(
        (row) =>
          row.userId === owner.id &&
          row.type === "whatsapp" &&
          row.verifiedAt !== null,
      ),
    },
  };
}

registerMock(listMfaFactors, ({ scenario }) => ({
  data: scenario === "empty" ? [] : state.get().factors,
}));

registerMock(enrollMfaFactor, ({ body }) => {
  const base = cafeLegendIdentityFixtures;
  const owner = base.usersByKey.owner;
  const factorId = mfaFactorIdSchema.parse(newIdempotencyKey());
  const factor = mfaFactorSchema.parse({
    id: factorId,
    userId: owner.id,
    type: body.type,
    createdAt: at(0),
  });
  const issuer = encodeURIComponent("Legend Super App");
  const account = encodeURIComponent(owner.displayName);
  const secretBase32 = totpSecret();

  const enrollment: MfaEnrollment =
    body.type === "totp"
      ? {
          type: "totp",
          factorId,
          secretBase32,
          otpauthUri: `otpauth://totp/${issuer}:${account}?issuer=${issuer}&algorithm=SHA1&digits=6&period=30&secret=${secretBase32}`,
          expiresAt: at(10 * 60_000),
        }
      : {
          type: "passkey",
          factorId,
          publicKeyOptions: {
            rp: { name: "Legend Super App", id: "localhost" },
            user: {
              id: "b3duZXItbWZhLWRlbW8",
              name: "owner@legend.example",
              displayName: owner.displayName,
            },
            challenge: "ZGVtby1jaGFsbGVuZ2U",
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            timeout: 60_000,
          },
        };

  state.get().pending.set(factorId, { enrollment, factor });
  return { data: enrollment };
});

registerMock(verifyMfaFactor, ({ body }) => {
  if ("code" in body && body.code === "000000")
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Kode tidak cocok. Periksa jam perangkat, lalu masukkan kode terbaru.",
    );

  const auth = state.get();
  const pending = auth.pending.get(body.factorId);
  if (pending) {
    auth.factors = [...auth.factors, pending.factor];
    auth.pending.delete(body.factorId);
  } else {
    findFactor(body.factorId);
  }

  const verifiedAt = at(0);
  auth.sessions = auth.sessions.map((view) =>
    view.current
      ? sessionViewSchema.parse({
          session: { ...view.session, mfaVerifiedAt: verifiedAt },
          current: true,
        })
      : view,
  );
  return { data: { factorId: body.factorId, verifiedAt } };
});

registerMock(deleteMfaFactor, ({ params }) => {
  const auth = state.get();
  findFactor(params.factorId);
  const owner = cafeLegendIdentityFixtures.usersByKey.owner;
  if (owner.mfaRequired && auth.factors.length <= 1)
    throw new ApiError(
      409,
      "CONFLICT",
      "Role ini mewajibkan faktor kedua. Tambahkan faktor lain sebelum menghapus yang terakhir.",
    );
  auth.factors = auth.factors.filter((row) => row.id !== params.factorId);
});

registerMock(listSessions, ({ scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : state.get().sessions.map((view) =>
          view.current
            ? sessionViewSchema.parse({
                session: withIdleKnob(view.session),
                current: true,
              })
            : view,
        ),
}));

registerMock(revokeSession, ({ params }) => {
  const auth = state.get();
  if (!auth.sessions.some((view) => view.session.id === params.sessionId))
    throw new ApiError(404, "NOT_FOUND", "Sesi tidak ditemukan.");
  auth.sessions = auth.sessions.filter(
    (view) => view.session.id !== params.sessionId,
  );
});

registerMock(listPushDevices, ({ scenario }) => ({
  data: scenario === "empty" ? [] : state.get().pushDevices,
}));

registerMock(revokePushDevice, ({ params }) => {
  const auth = state.get();
  if (!auth.pushDevices.some((device) => device.id === params.id))
    throw new ApiError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
  auth.pushDevices = auth.pushDevices.filter(
    (device) => device.id !== params.id,
  );
});

// AUTH-05: explicit activity extends a live staff session; reads do not.
registerMock(extendCurrentSession, () => {
  const session = currentSession();
  const clock = new Date();
  const path = (globalThis as { location?: { pathname?: string } }).location
    ?.pathname;
  if (
    path?.startsWith("/masuk") ||
    session.kind !== "management" ||
    session.revokedAt !== null ||
    clock.getTime() >= Date.parse(session.expiresAt) ||
    clock.getTime() >=
      Date.parse(session.lastSeenAt) + MANAGEMENT_IDLE_MINUTES * MINUTE_MS
  )
    throw new ApiError(401, "UNAUTHORIZED", "Sesi berakhir. Masuk kembali.");
  const result = recordSessionActivity({ session, now: clock, kind: "user" });
  if (!result.write) return;
  const auth = state.get();
  if (idleKnobOn()) {
    auth.idle = {
      lastSeenAt: result.session.lastSeenAt,
      expiresAt: result.session.expiresAt,
    };
  } else {
    auth.sessions = auth.sessions.map((view) =>
      view.current ? { ...view, session: result.session } : view,
    );
  }
});

registerMock(getMfaRecoveryStatus, ({ scenario }) => {
  const { recovery } = state.get();
  if (scenario === "empty")
    return { data: { remaining: 0, generatedAt: null } };
  return {
    data: {
      remaining: recovery.codes.length,
      generatedAt: recovery.generatedAt,
    },
  };
});

registerMock(generateMfaRecoveryCodes, () => {
  const auth = state.get();
  if (auth.factors.length === 0)
    throw new ApiError(
      409,
      "CONFLICT",
      "Siapkan verifikasi dua langkah dulu sebelum membuat kode cadangan.",
    );
  const generatedAt = at(0);
  auth.recovery = { codes: randomRecoveryCodes(), generatedAt, failed: 0 };
  return { data: { codes: [...auth.recovery.codes], generatedAt } };
});

registerMock(verifyMfaRecoveryCode, ({ body }) => {
  const { recovery } = state.get();
  if (recovery.failed >= RECOVERY_LOCK_AFTER)
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
    );
  const typed = body.code.replace(/-/g, "").toUpperCase();
  const index = recovery.codes.findIndex(
    (code) => code.replace(/-/g, "") === typed,
  );
  if (index === -1) {
    recovery.failed += 1;
    if (recovery.failed >= RECOVERY_LOCK_AFTER)
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
      );
    throw new ApiError(
      401,
      "MFA_RECOVERY_CODE_INVALID",
      "Kode tidak valid atau sudah digunakan.",
    );
  }
  recovery.codes.splice(index, 1);
  recovery.failed = 0;
  const verifiedAt = at(0);
  const auth = state.get();
  auth.sessions = auth.sessions.map((view) =>
    view.current
      ? sessionViewSchema.parse({
          session: { ...view.session, mfaVerifiedAt: verifiedAt },
          current: true,
        })
      : view,
  );
  return { data: { verifiedAt, remaining: recovery.codes.length } };
});
