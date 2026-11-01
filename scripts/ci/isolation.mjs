import assert from "node:assert/strict";

/**
 * Exercise the same resource using two independently authenticated tenants.
 *
 * setup() creates two tenants and a resource for each and returns
 * { tenants: [{ id, initial, replacement }, { id, initial, replacement }] }.
 * read(actorId, ownerId) returns the owner's normalized value or undefined for
 * a denied/not-found response. update(actorId, ownerId, value) attempts an
 * update and normalizes an expected authorization denial without throwing.
 * cleanup() must remove all fixture data, including after failed assertions.
 * The adapter must use separate real tenant sessions, never privileged reads.
 */
export async function runIsolationScenario(adapter) {
  try {
    const { tenants } = await adapter.setup();
    assert.equal(
      tenants.length,
      2,
      "Isolation fixture must contain exactly two tenants",
    );
    const [a, b] = tenants.map((tenant) => ({ ...tenant }));
    for (const tenant of [a, b]) {
      assert.notEqual(
        tenant.initial,
        undefined,
        "Isolation fixture needs an observable initial value",
      );
      assert.notEqual(
        tenant.replacement,
        undefined,
        "Isolation fixture needs a replacement value",
      );
      assert.notDeepEqual(
        tenant.initial,
        tenant.replacement,
        "Isolation fixture needs a distinct replacement value",
      );
    }
    assert.notDeepEqual(
      a.id,
      b.id,
      "Isolation fixture needs distinct tenant identities",
    );
    for (const [actor, other] of [
      [a, b],
      [b, a],
    ]) {
      assert.deepEqual(
        await adapter.read(actor.id, actor.id),
        actor.initial,
        "Tenant must read its own resource",
      );
      assert.equal(
        await adapter.read(actor.id, other.id),
        undefined,
        "Cross-tenant read exposed another tenant resource",
      );
      await adapter.update(actor.id, other.id, other.replacement);
      assert.deepEqual(
        await adapter.read(other.id, other.id),
        other.initial,
        "Cross-tenant write changed another tenant resource",
      );
      await adapter.update(actor.id, actor.id, actor.replacement);
      assert.deepEqual(
        await adapter.read(actor.id, actor.id),
        actor.replacement,
        "Tenant must update its own resource",
      );
      // Subsequent checks compare against the owner's current value.
      actor.initial = actor.replacement;
    }
  } finally {
    await adapter.cleanup();
  }
}
