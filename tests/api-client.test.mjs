// Typed endpoint contracts + FE mock mode (WS-00, bead legend-zj2).
// Loaded with plain Node ESM and built-in type stripping, like the sources
// run in the API and edge: no bundler, no resolve hook. Covers PRD v1.7 §3
// "Prinsip Pengembangan Paralel" (contract-first, FE builds on mocks) and the
// error envelope / cursor rules of docs/plan/contracts.md.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as api from "../packages/shared/src/api/index.ts";
import * as core from "../packages/shared/src/core/index.ts";
import {
  cancelGuestReservation,
  getGuestReservation,
} from "../packages/shared/src/reservation/self-service.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { createEndpointCaller } from "../apps/web/src/lib/api/endpoint-core.ts";
import * as control from "../apps/web/src/lib/mock/control.ts";
import {
  findMock,
  registerMock,
  registeredMockIds,
} from "../apps/web/src/lib/mock/registry.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/lib/mock/handlers/example.ts";

const { cafeLegendFixtures: fx, z } = core;
const bandung = fx.outlets[0];
const orderId = fx.orderId;

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

describe("endpoint contract helpers", () => {
  test("defineEndpoint builds an id and freezes the contract", () => {
    assert.equal(api.listExampleOutlets.id, "GET /api/example/outlets");
    assert.ok(Object.isFrozen(api.listExampleOutlets));
  });

  test("defineEndpoint rejects bad definitions", () => {
    assert.throws(
      () => api.defineEndpoint({ method: "GET", path: "api/x" }),
      /start with/,
    );
    assert.throws(
      () => api.defineEndpoint({ method: "GET", path: "/api/x/:id" }),
      /no params schema/,
    );
    assert.throws(
      () =>
        api.defineEndpoint({
          method: "GET",
          path: "/api/x",
          body: z.object({}),
        }),
      /cannot have a body/,
    );
  });

  test("pathParamNames lists :params in order", () => {
    assert.deepEqual(api.pathParamNames("/api/a/:orderId/lines/:lineId"), [
      "orderId",
      "lineId",
    ]);
    assert.deepEqual(api.pathParamNames("/api/a"), []);
  });

  test("buildEndpointPath encodes values and requires every param", () => {
    assert.equal(
      api.buildEndpointPath("/api/a/:id/b", { id: "x y/z" }),
      "/api/a/x%20y%2Fz/b",
    );
    assert.equal(api.buildEndpointPath("/api/a/:id", { id: 7 }), "/api/a/7");
    assert.throws(
      () => api.buildEndpointPath("/api/a/:id", {}),
      /Missing path param "id"/,
    );
    assert.throws(
      () => api.buildEndpointPath("/api/a/:id", { id: "" }),
      /Missing path param/,
    );
  });

  test("matchEndpointPath extracts params and rejects other shapes", () => {
    assert.deepEqual(api.matchEndpointPath("/api/a/:id/b", "/api/a/x%20y/b"), {
      id: "x y",
    });
    assert.equal(api.matchEndpointPath("/api/a/:id", "/api/a"), null);
    assert.equal(api.matchEndpointPath("/api/a/:id", "/api/a/"), null);
    assert.equal(api.matchEndpointPath("/api/a/:id", "/api/b/1"), null);
    assert.equal(api.matchEndpointPath("/api/a/:id", "/api/a/%E0%A4%A"), null);
  });

  test("zodIssuesToDetails gives dotted field paths", () => {
    const result = api.addExampleOrderLineInputSchema.safeParse({
      name: "",
      quantity: 0,
    });
    assert.ok(!result.success);
    const fields = api.zodIssuesToDetails(result.error).map((d) => d.field);
    assert.ok(fields.includes("name") && fields.includes("quantity"));
  });
});

describe("example contract + Cafe Legend fixtures", () => {
  test("the core fixtures parse against the example response schemas", () => {
    for (const outlet of fx.outlets)
      assert.ok(
        api.getExampleOutlet.response.safeParse({ data: outlet }).success,
      );
    assert.ok(
      api.listExampleOutlets.response.safeParse({
        data: fx.outlets,
        meta: { limit: 25, nextCursor: null },
      }).success,
    );
    for (const line of fx.orderLinesPage.data)
      assert.ok(
        api.addExampleOrderLine.response.safeParse({ data: line }).success,
      );
  });

  test("request schemas refuse a client-supplied tenantId (TEN-02)", () => {
    const valid = {
      name: "Es Teh",
      quantity: 1,
      unitPriceIdr: 12000,
      idempotencyKey: "key-12345678",
    };
    assert.ok(api.addExampleOrderLineInputSchema.safeParse(valid).success);
    assert.ok(
      !api.addExampleOrderLineInputSchema.safeParse({
        ...valid,
        tenantId: fx.tenant.id,
      }).success,
    );
    assert.ok(
      !api.addExampleOrderLineInputSchema.safeParse({
        ...valid,
        unitPriceIdr: 12000.5,
      }).success,
    );
  });
});

describe("mock runtime", () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test("registers the example handlers under their endpoint ids", () => {
    const ids = registeredMockIds();
    for (const endpoint of [
      api.listExampleOutlets,
      api.getExampleOutlet,
      api.addExampleOrderLine,
      api.removeExampleOrderLine,
    ])
      assert.ok(ids.includes(endpoint.id), endpoint.id);
  });

  test("lists with cursor pagination until nextCursor is null", async () => {
    const first = await dispatchMock({
      method: "GET",
      path: "/api/example/outlets",
      query: { limit: "1" },
    });
    assert.equal(first.data.length, 1);
    assert.equal(first.data[0].id, fx.outlets[0].id);
    assert.equal(typeof first.meta.nextCursor, "string");
    const second = await dispatchMock({
      method: "GET",
      path: "/api/example/outlets",
      query: { limit: "1", cursor: first.meta.nextCursor },
    });
    assert.equal(second.data[0].id, fx.outlets[1].id);
    assert.equal(second.meta.nextCursor, null);
  });

  test("a tampered cursor is VALIDATION_ERROR 400", async () => {
    const error = await failure(
      dispatchMock({
        method: "GET",
        path: "/api/example/outlets",
        query: { cursor: "!!!" },
      }),
    );
    assert.equal(error.status, 400);
    assert.equal(error.code, "VALIDATION_ERROR");
  });

  test("a limit above the maximum is rejected like the real API", async () => {
    const error = await failure(
      dispatchMock({
        method: "GET",
        path: "/api/example/outlets",
        query: { limit: "101" },
      }),
    );
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.details?.some((d) => d.field === "limit"));
  });

  test("path params are validated and unknown ids are 404", async () => {
    const bad = await failure(
      dispatchMock({ method: "GET", path: "/api/example/outlets/not-a-uuid" }),
    );
    assert.equal(bad.code, "VALIDATION_ERROR");
    const missing = await failure(
      dispatchMock({
        method: "GET",
        path: "/api/example/outlets/0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70",
      }),
    );
    assert.equal(missing.status, 404);
    const found = await dispatchMock({
      method: "GET",
      path: `/api/example/outlets/${bandung.id}`,
    });
    assert.deepEqual(found, { data: bandung });
  });

  test("POST validates the body, rejects tenantId, creates a line", async () => {
    const path = `/api/example/orders/${orderId}/lines`;
    const body = {
      name: "Es Teh Manis",
      quantity: 3,
      unitPriceIdr: 12000,
      idempotencyKey: "key-aaaaaaaa",
    };
    const rejected = await failure(
      dispatchMock({
        method: "POST",
        path,
        body: { ...body, tenantId: fx.tenant.id },
      }),
    );
    assert.equal(rejected.code, "VALIDATION_ERROR");
    const missing = await failure(dispatchMock({ method: "POST", path }));
    assert.equal(missing.code, "VALIDATION_ERROR");
    const created = await dispatchMock({ method: "POST", path, body });
    assert.equal(created.data.lineTotalIdr, 36000);
    assert.equal(created.data.name, "Es Teh Manis");
  });

  test("idempotency: same key replays, a different payload conflicts", async () => {
    const path = `/api/example/orders/${orderId}/lines`;
    const body = {
      name: "Teh Tarik",
      quantity: 1,
      unitPriceIdr: 15000,
      idempotencyKey: "key-bbbbbbbb",
    };
    const first = await dispatchMock({ method: "POST", path, body });
    const replay = await dispatchMock({ method: "POST", path, body });
    assert.equal(replay.data.id, first.data.id);
    const reused = await failure(
      dispatchMock({ method: "POST", path, body: { ...body, quantity: 2 } }),
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
  });

  test("DELETE answers undefined (204) and then 404; reset restores seed data", async () => {
    const lineId = fx.orderLinesPage.data[0].id;
    const path = `/api/example/orders/${orderId}/lines/${lineId}`;
    assert.equal(await dispatchMock({ method: "DELETE", path }), undefined);
    assert.equal(
      (await failure(dispatchMock({ method: "DELETE", path }))).status,
      404,
    );
    resetMocks();
    assert.equal(await dispatchMock({ method: "DELETE", path }), undefined);
  });

  test("an unregistered route is a descriptive NOT_FOUND", async () => {
    const error = await failure(
      dispatchMock({ method: "GET", path: "/api/nope" }),
    );
    assert.equal(error.status, 404);
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /registerMock/);
  });

  test("empty scenario returns an empty last page", async () => {
    control.setScenario("empty");
    const page = await dispatchMock({
      method: "GET",
      path: "/api/example/outlets",
    });
    assert.deepEqual(page, { data: [], meta: { limit: 25, nextCursor: null } });
  });

  test("error scenario is INTERNAL_ERROR 500; offline is NETWORK_ERROR status 0", async () => {
    control.setScenario("error");
    const server = await failure(
      dispatchMock({ method: "GET", path: "/api/example/outlets" }),
    );
    assert.deepEqual([server.status, server.code], [500, "INTERNAL_ERROR"]);
    control.setScenario("offline");
    const offline = await failure(
      dispatchMock({ method: "GET", path: "/api/example/outlets" }),
    );
    assert.deepEqual([offline.status, offline.code], [0, "NETWORK_ERROR"]);
  });

  test("failNext fails exactly one matching call, with the given code", async () => {
    control.failNext(api.listExampleOutlets.id, {
      status: 403,
      code: "OUTLET_OUT_OF_SCOPE",
    });
    const denied = await failure(
      dispatchMock({ method: "GET", path: "/api/example/outlets" }),
    );
    assert.deepEqual(
      [denied.status, denied.code],
      [403, "OUTLET_OUT_OF_SCOPE"],
    );
    const ok = await dispatchMock({
      method: "GET",
      path: "/api/example/outlets",
    });
    assert.equal(ok.data.length, fx.outlets.length);
  });

  test("slow scenario delays, and an abort cancels the wait", async () => {
    control.setScenario("slow");
    const controller = new AbortController();
    const pending = dispatchMock({
      method: "GET",
      path: "/api/example/outlets",
      signal: controller.signal,
    });
    setTimeout(
      () => controller.abort(new DOMException("aborted", "AbortError")),
      10,
    );
    await assert.rejects(pending, { name: "AbortError" });
  });

  test("CoreError thrown by a handler maps to its status and code", async () => {
    const probe = api.defineEndpoint({
      method: "GET",
      path: "/api/example/probe-core-error",
    });
    registerMock(probe, () => {
      throw new core.CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Di luar cakupan outlet.",
      );
    });
    const error = await failure(
      dispatchMock({ method: "GET", path: "/api/example/probe-core-error" }),
    );
    assert.deepEqual([error.status, error.code], [403, "OUTLET_OUT_OF_SCOPE"]);
  });

  test("a handler response that breaks the contract is MOCK_RESPONSE_INVALID", async () => {
    const probe = api.defineEndpoint({
      method: "GET",
      path: "/api/example/probe-bad-shape",
      response: z.object({ data: z.string() }),
    });
    registerMock(probe, () => ({ data: 42 }));
    const error = await failure(
      dispatchMock({ method: "GET", path: "/api/example/probe-bad-shape" }),
    );
    assert.equal(error.code, "MOCK_RESPONSE_INVALID");
    assert.ok(error.details?.length);
  });

  test("a static path wins over one with :params", () => {
    const wild = api.defineEndpoint({
      method: "GET",
      path: "/api/example/zz/:id",
      params: z.object({ id: z.string() }),
    });
    const exact = api.defineEndpoint({
      method: "GET",
      path: "/api/example/zz/special",
    });
    registerMock(wild, () => undefined);
    registerMock(exact, () => undefined);
    assert.equal(
      findMock("GET", "/api/example/zz/special")?.entry.endpoint.id,
      exact.id,
    );
    assert.equal(
      findMock("GET", "/api/example/zz/other")?.entry.endpoint.id,
      wild.id,
    );
  });
});

describe("typed endpoint caller", () => {
  const calls = [];
  const transport = async (path, request) => {
    calls.push({ path, request });
    if (path.endsWith("/bad")) return { data: "nope" };
    return dispatchMock({
      method: request.method,
      path,
      query: request.query,
      body: request.body,
      signal: request.signal,
    });
  };
  const call = createEndpointCaller(transport, {
    validateResponse: () => true,
  });

  beforeEach(() => {
    calls.length = 0;
    resetMocks();
  });

  test("legend-8tv6 sends a validated Idempotency-Key and rejects unsafe headers", async () => {
    await call(api.listExampleOutlets, undefined, {
      headers: { "Idempotency-Key": "attempt-123" },
    });
    assert.deepEqual(calls[0].request.headers, {
      "Idempotency-Key": "attempt-123",
    });
    for (const headers of [
      { "Idempotency-Key": "bad key" },
      { Authorization: "secret" },
    ]) {
      const error = await failure(
        call(api.listExampleOutlets, undefined, { headers }),
      );
      assert.equal(error.code, "VALIDATION_ERROR");
    }
    assert.equal(calls.length, 1);
  });

  test("sends a valid X-Reservation-Link-Token and rejects a malformed one", async () => {
    const token = "A".repeat(43);
    await call(api.listExampleOutlets, undefined, {
      headers: { "X-Reservation-Link-Token": token },
    });
    assert.deepEqual(calls.at(-1).request.headers, {
      "X-Reservation-Link-Token": token,
    });
    const before = calls.length;
    for (const bad of ["short", `${"A".repeat(42)}!`, "A".repeat(44)]) {
      const error = await failure(
        call(api.listExampleOutlets, undefined, {
          headers: { "X-Reservation-Link-Token": bad },
        }),
      );
      assert.equal(error.code, "VALIDATION_ERROR");
    }
    assert.equal(calls.length, before);
  });

  // legend-g12il: the public guest page sends its link token in a header.
  const LINK_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";
  // Records the call and answers with an empty body; no mock handler needed.
  const tokenCalls = [];
  const tokenCall = createEndpointCaller(
    async (path, request) => {
      tokenCalls.push({ path, request });
      return { data: {} };
    },
    { validateResponse: () => false },
  );
  beforeEach(() => {
    tokenCalls.length = 0;
  });

  test("legend-g12il forwards a valid X-Reservation-Link-Token header", async () => {
    await tokenCall(getGuestReservation, undefined, {
      headers: { "X-Reservation-Link-Token": LINK_TOKEN },
    });
    assert.deepEqual(tokenCalls[0].request.headers, {
      "X-Reservation-Link-Token": LINK_TOKEN,
    });
  });

  test("legend-g12il sends the link token together with an Idempotency-Key", async () => {
    await tokenCall(
      cancelGuestReservation,
      { body: {} },
      {
        headers: {
          "X-Reservation-Link-Token": LINK_TOKEN,
          "Idempotency-Key": "attempt-12345",
        },
      },
    );
    assert.deepEqual(tokenCalls[0].request.headers, {
      "X-Reservation-Link-Token": LINK_TOKEN,
      "Idempotency-Key": "attempt-12345",
    });
  });

  test("legend-g12il rejects a malformed link token before any request", async () => {
    for (const token of [
      "",
      "short",
      `${LINK_TOKEN}x`,
      `${LINK_TOKEN.slice(1)}+`,
    ]) {
      const error = await failure(
        tokenCall(getGuestReservation, undefined, {
          headers: { "X-Reservation-Link-Token": token },
        }),
      );
      assert.equal(error.code, "VALIDATION_ERROR");
    }
    assert.equal(tokenCalls.length, 0);
  });

  test("builds the path, sends parsed query and returns the typed page", async () => {
    // A handler registered here replaces the example one for this contract.
    registerMock(
      api.listExampleOutlets,
      ({ query }) => ({
        data: fx.outlets.slice(0, query.limit),
        meta: { limit: query.limit, nextCursor: null },
      }),
      { replace: true },
    );
    const page = await call(api.listExampleOutlets, { query: { limit: 1 } });
    assert.equal(calls[0].path, "/api/example/outlets");
    assert.deepEqual(calls[0].request.query, { limit: 1 });
    assert.equal(page.data.length, 1);
  });

  test("applies schema defaults and sends the path with encoded params", async () => {
    registerMock(
      api.getExampleOutlet,
      ({ params }) => ({
        data: fx.outlets.find((o) => o.id === params.outletId),
      }),
      { replace: true },
    );
    const defaults = await call(api.listExampleOutlets);
    assert.deepEqual(calls[0].request.query, { limit: 25 });
    assert.equal(defaults.meta.limit, 25);
    const one = await call(api.getExampleOutlet, {
      params: { outletId: bandung.id.toUpperCase() },
    });
    assert.equal(calls[1].path, `/api/example/outlets/${bandung.id}`);
    assert.equal(one.data.code, "BDG-01");
  });

  test("bad input fails before the network with VALIDATION_ERROR details", async () => {
    const error = await failure(
      call(api.listExampleOutlets, { query: { limit: 0 } }),
    );
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(calls.length, 0);
    const noBody = await failure(
      call(api.addExampleOrderLine, { params: { orderId } }),
    );
    assert.equal(noBody.code, "VALIDATION_ERROR");
  });

  test("a response that drifts from the contract is RESPONSE_SHAPE_INVALID", async () => {
    const drift = api.defineEndpoint({
      method: "GET",
      path: "/api/example/bad",
      response: z.object({ data: z.number() }),
    });
    const error = await failure(call(drift));
    assert.equal(error.code, "RESPONSE_SHAPE_INVALID");
    const lenient = createEndpointCaller(transport, {
      validateResponse: () => false,
    });
    assert.deepEqual(await lenient(drift), { data: "nope" });
  });

  test("a void endpoint resolves undefined", async () => {
    // The example handler owns the endpoint; this test overrides it on purpose.
    registerMock(api.removeExampleOrderLine, () => undefined, {
      replace: true,
    });
    const lineId = fx.orderLinesPage.data[0].id;
    assert.equal(
      await call(api.removeExampleOrderLine, { params: { orderId, lineId } }),
      undefined,
    );
  });
});
