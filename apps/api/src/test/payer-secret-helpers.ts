// legend-r77pq: the payer secret a paying client makes for a split part. Tests
// stand in for that client: one remembered secret per part (like the browser's
// sessionStorage), and fresh ones for "another guest".
import { randomBytes } from "node:crypto";

const secrets = new Map<string, string>();

/** A fresh, well-formed `ps_` secret (32 random bytes, base64url). */
export function newPayerSecret(): string {
  return `ps_${randomBytes(32).toString("base64url")}`;
}

/** The secret the test's paying client uses for this part (made once). */
export function secretFor(billSplitId: string): string {
  let secret = secrets.get(billSplitId);
  if (secret === undefined) {
    secret = newPayerSecret();
    secrets.set(billSplitId, secret);
  }
  return secret;
}
