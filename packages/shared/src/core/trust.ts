// INTERNAL provenance registry for tenant contexts and outlet scopes.
// Not exported from any package entry point: the browser-safe entry
// (`@starter/shared/core`) can only *check* membership; only the server entry
// (`@starter/shared/core/server`) can *mint*. A WeakSet entry is the runtime
// proof that an object was made by a server resolver: a plain object, a JSON
// round-trip, a structuredClone or a spread copy is never a member.
// Fails closed: if two copies of this module are ever loaded, objects from one
// are rejected by the other.

const trustedTenantContexts = new WeakSet<object>();
const trustedOutletScopes = new WeakSet<object>();

export function mintTenantContext<T extends object>(value: T): Readonly<T> {
  const frozen = Object.freeze(value);
  trustedTenantContexts.add(frozen);
  return frozen;
}

export function mintOutletScope<T extends object>(value: T): Readonly<T> {
  const frozen = Object.freeze(value);
  trustedOutletScopes.add(frozen);
  return frozen;
}

export function hasTenantContextProvenance(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedTenantContexts.has(value)
  );
}

export function hasOutletScopeProvenance(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedOutletScopes.has(value)
  );
}
