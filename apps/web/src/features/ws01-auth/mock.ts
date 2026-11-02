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
// A mock-only knob shows the idle warning without waiting 22 minutes:
//   localStorage["legend-mock-session"] = "idle"  → current session ends in 2m
//   localStorage.removeItem("legend-mock-session")
//
// Verification accepts any six digits except 000000 (wrong-code state).
import {
  cafeLegendIdentityFixtures,
  deleteMfaFactor,
  enrollMfaFactor,
  listMfaFactors,
  listSessions,
  mfaFactorIdSchema,
  mfaFactorSchema,
  revokeSession,
  sessionSchema,
  sessionViewSchema,
  verifyMfaFactor,
  type MfaEnrollment,
  type MfaFactor,
  type Session,
  type SessionView,
} from "@starter/shared/identity";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

/** Mock-only knob for the idle warning; ignored in a real build. */
export const MOCK_SESSION_KNOB = "legend-mock-session";

type PendingFactor = { enrollment: MfaEnrollment; factor: MfaFactor };

type AuthMockState = {
  factors: MfaFactor[];
  sessions: SessionView[];
  pending: Map<string, PendingFactor>;
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

const seed = (): AuthMockState => ({
  factors: cafeLegendIdentityFixtures.mfaFactors.filter(
    (row) => row.userId === cafeLegendIdentityFixtures.usersByKey.owner.id,
  ),
  sessions: seedSessions(),
  pending: new Map(),
});

const state = createMockStore<AuthMockState>(seed);

/** The idle knob shortens this one session's idle end for a demo. */
function withIdleKnob(session: Session): Session {
  if (!idleKnobOn()) return session;
  return { ...session, lastSeenAt: at(-3 * 60_000), expiresAt: at(110_000) };
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
  const factorId = mfaFactorIdSchema.parse(crypto.randomUUID());
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
  if (body.code === "000000")
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
