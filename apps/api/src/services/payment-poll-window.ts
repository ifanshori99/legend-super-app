/**
 * How long after its expiry a gateway code keeps being asked about (SO-885).
 * A leaf module (no imports) so reservation code can share the number with the
 * payment poller without an import cycle; `payment.service.ts` re-exports it.
 *
 * Must stay >= the life of a DOIT virtual account (180 minutes), see the
 * comment on the poller in `payment.service.ts`.
 */
export const GATEWAY_POLL_WINDOW_MS = 24 * 60 * 60_000;
