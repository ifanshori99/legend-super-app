import test from "node:test";
import assert from "node:assert/strict";
import { runIsolationScenario } from "./isolation.mjs";

function adapter({ leakRead = false, leakWrite = false } = {}) {
  const records = new Map();
  return {
    async setup() {
      records.set("a", "alpha");
      records.set("b", "beta");
      return {
        tenants: [
          { id: "a", initial: "alpha", replacement: "alpha-updated" },
          { id: "b", initial: "beta", replacement: "beta-updated" },
        ],
      };
    },
    async read(actor, owner) {
      return actor === owner || leakRead ? records.get(owner) : undefined;
    },
    async update(actor, owner, value) {
      if (actor === owner || leakWrite) records.set(owner, value);
    },
    async cleanup() {
      records.clear();
    },
  };
}

test("accepts isolated reads and writes in both tenant directions", async () => {
  await runIsolationScenario(adapter());
});

test("rejects cross-tenant reads", async () => {
  await assert.rejects(
    runIsolationScenario(adapter({ leakRead: true })),
    /cross-tenant read/i,
  );
});

test("rejects cross-tenant writes even if the operation reports success", async () => {
  await assert.rejects(
    runIsolationScenario(adapter({ leakWrite: true })),
    /cross-tenant write/i,
  );
});

test("always cleans up when isolation assertion fails", async () => {
  const instance = adapter({ leakRead: true });
  let cleaned = false;
  instance.cleanup = async () => {
    cleaned = true;
  };
  await assert.rejects(runIsolationScenario(instance));
  assert.equal(cleaned, true);
});

test("rejects fixtures with no observable update", async () => {
  const instance = adapter();
  const setup = instance.setup;
  instance.setup = async () => {
    const fixture = await setup();
    fixture.tenants[0].replacement = fixture.tenants[0].initial;
    return fixture;
  };
  await assert.rejects(runIsolationScenario(instance), /distinct replacement/i);
});

test("rejects a missing replacement value", async () => {
  const instance = adapter();
  const setup = instance.setup;
  instance.setup = async () => {
    const fixture = await setup();
    fixture.tenants[0].replacement = undefined;
    return fixture;
  };
  await assert.rejects(runIsolationScenario(instance), /replacement value/i);
});
