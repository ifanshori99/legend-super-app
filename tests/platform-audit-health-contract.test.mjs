// legend-bag1: the cross-tenant audit list and the platform health endpoint move
// into the shared platform contract (PRD v1.7 §3 F4: Super Admin "melihat
// kesehatan sistem dan audit lintas tenant"), with a dedicated permission
// `platform.audit.view` next to the existing `platform.health.view`.
// Contract level only, no database.
//
// Assumptions (the card does not fix names or the health payload):
//  - Both endpoints are found in `platformEndpoints` by method and path:
//    GET /api/platform/audit-events and GET /api/platform/health. No export
//    name is assumed, so the engineer picks it.
//  - The audit query keeps the filters the web contract-gap file defines today
//    (tenantId, actorType, action prefix, from, to) plus cursor and limit; the
//    response is a cursor page of the shared auditEventSchema (which carries the
//    row's tenantId, so a platform reader sees which tenant each event is from).
//  - The health response schema is a non-empty strict object. Its fields are
//    not asserted beyond "an empty object is not a health report".
//  - `platform.audit.view` carries the "platform" tag: only Super Admin holds
//    it and it is never a tenant permission (like platform.health.view).
import assert from "node:assert/strict";
import { test } from "node:test";

import * as access from "../packages/shared/src/access/index.ts";
import * as audit from "../packages/shared/src/audit/index.ts";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";
import * as platform from "../packages/shared/src/platform/index.ts";

const endpoints = Object.values(platform.platformEndpoints);
const find = (method, path) =>
  endpoints.find((e) => e.method === method && e.path === path);

test("legend-bag1 permission platform.audit.view is a platform-only permission held by Super Admin alone", () => {
  const code = "platform.audit.view";
  assert.ok(access.PERMISSION_CODES.includes(code), `${code} is not defined`);
  assert.ok(access.permissionHasTag(code, "platform"));
  assert.equal(
    access.tenantPermissionCodeSchema.safeParse(code).success,
    false,
  );
  assert.ok(access.roleTemplate("super_admin").permissions.includes(code));
  for (const key of ["owner", "tenant_admin", "general_manager", "finance"])
    assert.ok(
      !access.roleTemplate(key).permissions.includes(code),
      `${key} must not see the cross-tenant audit`,
    );
  // The existing health permission stays alongside it.
  assert.ok(access.PERMISSION_CODES.includes("platform.health.view"));
});

test("legend-bag1 GET /api/platform/audit-events is part of the shared platform contract", () => {
  const endpoint = find("GET", "/api/platform/audit-events");
  assert.ok(
    endpoint,
    "platformEndpoints has no GET /api/platform/audit-events",
  );
  assert.equal(endpoint.body, undefined);
  assert.equal(endpoint.params, undefined);
});

test("legend-bag1 the audit list query accepts the cross-tenant filters and refuses bad ones", () => {
  const endpoint = find("GET", "/api/platform/audit-events");
  assert.ok(endpoint, "audit endpoint missing");
  const tenantId = cafeLegendFixtures.tenant.id;
  // Empty query: first page, default limit.
  assert.equal(endpoint.query.safeParse({}).success, true);
  const parsed = endpoint.query.safeParse({
    tenantId,
    actorType: "user",
    action: "tenant.",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-02T00:00:00.000Z",
    limit: "50",
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.tenantId, tenantId);
  assert.equal(parsed.data.limit, 50);
  for (const bad of [
    { tenantId: "not-a-uuid" },
    { actorType: "robot" },
    { limit: 0 },
    { limit: 101 },
    { from: "yesterday" },
    { unknownFilter: "x" },
  ])
    assert.equal(
      endpoint.query.safeParse(bad).success,
      false,
      `accepted ${JSON.stringify(bad)}`,
    );
});

test("legend-bag1 the audit list answers a cursor page of masked audit events with their tenant", () => {
  const endpoint = find("GET", "/api/platform/audit-events");
  assert.ok(endpoint, "audit endpoint missing");
  const page = {
    data: audit.cafeLegendAuditFixtures,
    meta: { limit: 25, nextCursor: null },
  };
  const parsed = endpoint.response.safeParse(page);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.data[0].tenantId, cafeLegendFixtures.tenant.id);
  // An empty page is a valid answer (no events match).
  assert.equal(
    endpoint.response.safeParse({
      data: [],
      meta: { limit: 25, nextCursor: null },
    }).success,
    true,
  );
  // A row whose changes are not masked is refused (the event schema's rule).
  const leaking = {
    ...audit.cafeLegendAuditFixtures[0],
    maskedChanges: { before: null, after: { password: "hunter2" } },
  };
  assert.equal(
    endpoint.response.safeParse({
      data: [leaking],
      meta: { limit: 25, nextCursor: null },
    }).success,
    false,
  );
  assert.equal(endpoint.response.safeParse({ data: [] }).success, false);
});

test("legend-bag1 GET /api/platform/health is part of the shared platform contract with a non-empty report", () => {
  const endpoint = find("GET", "/api/platform/health");
  assert.ok(endpoint, "platformEndpoints has no GET /api/platform/health");
  assert.equal(endpoint.body, undefined);
  assert.equal(endpoint.params, undefined);
  assert.ok(endpoint.response, "health endpoint has no response schema");
  assert.equal(
    endpoint.response.safeParse({}).success,
    false,
    "an empty object is not a health report",
  );
  assert.equal(
    endpoint.response.safeParse(undefined).success,
    false,
    "no body is not a health report",
  );
});
