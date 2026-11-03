// One-shot holder for credential values typed into the integration form
// (PAY-06 "no secrets to client", PRD v1.7 §3 F4 "Integrasi per Tenant").
//
// TanStack Query keeps mutation variables in its mutation cache. A secret
// passed as a variable would therefore live in the cache after the save. The
// form instead puts the values in a buffer, passes only the buffer to the
// mutation, and the sender takes the values out exactly once. The buffer
// serializes to `{}` (it holds only functions), so nothing a cache, a log or a
// devtools dump can reach ever contains a credential.

export type SecretValues = Record<string, string>;

export type SecretBuffer = {
  /** Replaces whatever is held; the caller clears its own copy right after. */
  put: (values: SecretValues) => void;
  /** Returns the held values and forgets them. Undefined when nothing is held. */
  take: () => SecretValues | undefined;
};

export function createSecretBuffer(): SecretBuffer {
  let held: SecretValues | undefined;
  return {
    put(values) {
      held = { ...values };
    },
    take() {
      const out = held;
      held = undefined;
      return out;
    },
  };
}
