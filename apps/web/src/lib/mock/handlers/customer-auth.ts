// The customer side of the identity mock: who this browser is signed in as and
// the GET /api/auth/me payload, shared by the sign-in screens (ws01-login) and
// the WhatsApp gate on the facility journey. Node-loadable (relative imports
// only), because tests/login-flow.test.mjs imports the login mock directly.
//
// GET /api/auth/me has one more owner (ws01-auth, the staff view).
// lib/mock/handlers/current-auth.ts is the browser's single registration: it
// picks a side per page and replaces this default (bead legend-jzud).
import {
  cafeLegendIdentityFixtures as idFx,
  CUSTOMER_SESSION_DAYS,
  currentAuthViewSchema,
  DAY_MS,
  getCurrentAuth,
  sessionSchema,
  type CurrentAuthView,
  type Session,
} from "@starter/shared/identity";
import { ApiError } from "../../api/errors.ts";
import { registerMock } from "../registry.ts";
import { createMockStore } from "../store.ts";
import { newIdempotencyKey } from "../../idempotency.ts";

/** The identity customer (Sari): a verified WhatsApp number. */
const customerUser = idFx.usersByKey.sari;

/** Which account the mock browser is signed in as; "fixture" = the fixture view. */
export type MockAuth = "fixture" | "customer";
export const auth = createMockStore<MockAuth>(() => "fixture");

/** A fresh session for the customer who just signed in (90 days, §3 F3). */
export function newCustomerSession(at: Date): Session {
  return sessionSchema.parse({
    id: newIdempotencyKey(),
    userId: customerUser.id,
    tenantId: idFx.tenantId,
    kind: "customer",
    deviceLabel: "Browser ini",
    createdAt: at.toISOString(),
    lastSeenAt: at.toISOString(),
    expiresAt: new Date(
      at.getTime() + CUSTOMER_SESSION_DAYS * DAY_MS,
    ).toISOString(),
    revokedAt: null,
    mfaVerifiedAt: null,
  });
}

function customerAuthView(
  session: Session,
  whatsAppVerified = true,
): CurrentAuthView {
  return currentAuthViewSchema.parse({
    user: customerUser,
    identities: idFx.identities.filter(
      (identity) => identity.userId === customerUser.id,
    ),
    mfaFactors: [],
    session,
    mfaRequired: false,
    mfaEnrollmentRequired: false,
    whatsAppVerified,
  });
}

/** The customer side of GET /api/auth/me (default registration). */
export function customerCurrentAuthMock({ scenario }: { scenario: string }): {
  data: CurrentAuthView;
} {
  // `empty`: no session in this browser — the link prompt's signed-out state.
  if (scenario === "empty")
    throw new ApiError(401, "UNAUTHORIZED", "Belum masuk.");
  // `wa-unverified*` / `wa-verified`: the member WhatsApp prompt (legend-vnvg).
  // Unset, the customer is verified and the fixture view keeps its own value.
  const forceUnverified =
    scenario === "wa-unverified" || scenario === "wa-unverified-empty";
  if (auth.get() === "customer")
    return {
      data: customerAuthView(newCustomerSession(new Date()), !forceUnverified),
    };
  if (forceUnverified || scenario === "wa-verified")
    return {
      data: {
        ...idFx.currentAuth,
        whatsAppVerified: scenario === "wa-verified",
      },
    };
  return { data: idFx.currentAuth };
}

registerMock(getCurrentAuth, customerCurrentAuthMock);
