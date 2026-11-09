// legend-wbwl + legend-6jms: in mock mode the config read serves what the admin
// saved (an edit survives a refetch), a stale `expectedUpdatedAt` is a 412, and
// a create with a known `idempotencyKey` returns the first row.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { cafeLegendFacilityFixtures as fx } from "../packages/shared/src/facility/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/facility/mock.ts";
import "../apps/web/src/features/facility-admin/mock.ts";

const facilityId = fx.ids.showerFacilityId;

const request = (method, path, { query, body } = {}) =>
  dispatchMock({ method, path, query, body });
const config = async () =>
  (await request("GET", "/api/facility/config", { query: { facilityId } }))
    .data;

beforeEach(() => resetMocks());

describe("facility admin mock (legend-wbwl, legend-6jms)", () => {
  test("a saved Wi-Fi policy survives a config refetch and a stale stamp is a 412", async () => {
    const policy = (await config()).wifiPolicies[0];
    const { id, updatedAt, ...columns } = policy;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit scope fields
    const { tenantId, outletId, ...body } = columns;
    const saved = (
      await request("PUT", `/api/wifi/policies/${id}`, {
        body: { ...body, freeMinutes: 150, expectedUpdatedAt: updatedAt },
      })
    ).data;
    assert.equal(saved.freeMinutes, 150);
    assert.notEqual(saved.updatedAt, "");
    const refetched = (await config()).wifiPolicies.find((p) => p.id === id);
    assert.equal(refetched.freeMinutes, 150);
    await assert.rejects(
      request("PUT", `/api/wifi/policies/${id}`, {
        body: { ...body, freeMinutes: 90, expectedUpdatedAt: updatedAt },
      }),
      (error) => error.status === 412,
    );
    assert.equal(
      (await config()).wifiPolicies.find((p) => p.id === id).freeMinutes,
      150,
    );
  });

  test("PATCH is refused on a stale stamp (412); POST replays by key and refuses another payload (409)", async () => {
    const product = (await config()).products[0];
    const patched = (
      await request("PATCH", `/api/facility/products/${product.id}`, {
        body: { priceIdr: 31000, expectedUpdatedAt: product.updatedAt },
      })
    ).data;
    assert.equal(patched.priceIdr, 31000);
    await assert.rejects(
      request("PATCH", `/api/facility/products/${product.id}`, {
        body: { priceIdr: 1000, expectedUpdatedAt: product.updatedAt },
      }),
      (error) => error.status === 412,
    );
    assert.equal(
      (await config()).products.find((p) => p.id === product.id).priceIdr,
      31000,
    );

    const create = {
      facilityId,
      name: "Area Mock",
      idempotencyKey: "mock-key-1",
    };
    const first = (
      await request("POST", "/api/facility/areas", { body: create })
    ).data;
    const replay = (
      await request("POST", "/api/facility/areas", { body: create })
    ).data;
    assert.equal(replay.id, first.id);
    assert.equal(
      (await config()).areas.filter((area) => area.name === "Area Mock").length,
      1,
    );
    await assert.rejects(
      request("POST", "/api/facility/areas", {
        body: { ...create, name: "Lain" },
      }),
      (error) => error.status === 409,
    );
  });

  test("a dialog opened on an old row cannot overwrite a newer save (412); a new Wi-Fi policy needs a facilityId (400)", async () => {
    const policy = (await config()).wifiPolicies[0];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit scope fields
    const { id, updatedAt, tenantId, outletId, ...body } = policy;
    // Admin B saves; admin A's dialog still holds the stamp from when it opened.
    await request("PUT", `/api/wifi/policies/${id}`, {
      body: { ...body, freeMinutes: 150, expectedUpdatedAt: updatedAt },
    });
    await assert.rejects(
      request("PUT", `/api/wifi/policies/${id}`, {
        body: { ...body, freeMinutes: 90, expectedUpdatedAt: updatedAt },
      }),
      (error) => error.status === 412,
    );
    assert.equal(
      (await config()).wifiPolicies.find((p) => p.id === id).freeMinutes,
      150,
    );
    await assert.rejects(
      request("PUT", `/api/wifi/policies/${crypto.randomUUID()}`, {
        body: { ...body, expectedUpdatedAt: null },
      }),
      (error) => error.status === 400 && error.code === "VALIDATION_ERROR",
    );
  });
});
