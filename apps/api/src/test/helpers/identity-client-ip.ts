// One client IP per identity test file (bead legend-5opkl).
//
// AUTH-04 counts challenges per client IP across every tenant, and supertest
// always connects from 127.0.0.1, so identity files running in parallel
// workers used up each other's five-per-fifteen-minutes budget. Trusting one
// proxy hop makes the app read the IP from X-Forwarded-For; each file sends its
// own address.
//
// Import this module BEFORE anything that loads `../app` or `../config/env`:
// the env is read once, when that module is first imported. Call
// `releaseTrustedProxy()` in afterAll so a later file in the same worker is not
// affected.

const previous = process.env.TRUST_PROXY;
process.env.TRUST_PROXY = "1";

const octet = () => Math.floor(Math.random() * 250) + 1;

/** An address from 10.0.0.0/8, random per file run. */
export const FILE_CLIENT_IP = `10.${octet()}.${octet()}.${octet()}`;

export function releaseTrustedProxy() {
  if (previous === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previous;
}
