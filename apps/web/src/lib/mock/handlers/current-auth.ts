// One mock for GET /api/auth/me, shared by two features (Opus review,
// legend-9bh): the customer sign-in screens (ws01-login, /masuk*) and the staff
// second-factor and security screens (ws01-auth). Each feature registers its
// own handler for its node tests; in the browser the registry keeps one entry
// per endpoint, so the glob order decided which screen worked. Importing both
// modules first and registering last makes this arbiter win in any order.
import { getCurrentAuth } from "@starter/shared/identity";
import { customerCurrentAuthMock } from "../../../features/ws01-login/mock.ts";
import { staffCurrentAuthMock } from "../../../features/ws01-auth/mock.ts";
import { registerMock } from "../registry.ts";

function onCustomerPage(): boolean {
  const location = (globalThis as { location?: { pathname?: string } })
    .location;
  return location?.pathname?.startsWith("/masuk") ?? false;
}

registerMock(getCurrentAuth, (context) =>
  onCustomerPage()
    ? customerCurrentAuthMock(context)
    : staffCurrentAuthMock(context),
);
