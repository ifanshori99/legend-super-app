// One mock for GET /api/auth/me, shared by two features (Opus review,
// legend-9bh): the customer sign-in screens (ws01-login, /masuk*) and the staff
// second-factor and security screens (ws01-auth). `customer-auth.ts` registers
// the customer view as the default (the Node suites import it directly); this
// arbiter replaces that registration in the browser and picks a side per page,
// so the plain `registerMock` duplicate guard does not fire (bead legend-jzud).
import { getCurrentAuth } from "@starter/shared/identity";
import { staffCurrentAuthMock } from "../../../features/ws01-auth/mock.ts";
import { registerMock } from "../registry.ts";
import { customerCurrentAuthMock } from "./customer-auth.ts";

function onCustomerPage(): boolean {
  const location = (globalThis as { location?: { pathname?: string } })
    .location;
  // /member: the member screens read whatsAppVerified for the link prompt
  // (legend-vnvg); they are customer pages.
  const path = location?.pathname ?? "";
  return path.startsWith("/masuk") || path.startsWith("/member");
}

registerMock(
  getCurrentAuth,
  (context) =>
    onCustomerPage()
      ? customerCurrentAuthMock(context)
      : staffCurrentAuthMock(context),
  { replace: true },
);
