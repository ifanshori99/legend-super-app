# Brief: test T1 people snapshot (legend-ye4j1, C2)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ye4j1` (branch `ws/ye4j1-people-snapshot`). Only create `apps/api/src/test/edge-people-snapshot.test.ts`. Do not touch other files. Do not run the test (the engineer runs it via `heavy`).

Spec: `docs/design/hris-edge-replication.md` §3.1, §3.2, §3.5, §4 and §9 T1.
Contract: `packages/shared/src/edge/people-snapshot.ts` (strict Zod, whitelists).

## Interface under test (does not exist yet; the engineer writes it)

`apps/api/src/services/edge-people-snapshot.ts`:

```ts
export type PeopleSnapshotResult = {
  body: EdgePeopleSnapshot;     // validated by edgePeopleSnapshotSchema
  etag: string;                 // `"<sha256 hex>"` of the canonical data sections only
  generatedAt: string;          // ISO, header only
};
export async function buildEdgePeopleSnapshot(
  node: VerifiedEdgeNode,       // {tenantId, outletId, edgeNodeId}
  options?: { now?: Date },
): Promise<PeopleSnapshotResult>;
```

Route: `GET /api/edge-sync/people-snapshot` in `apps/api/src/routes/edge-people-snapshot.routes.ts`, exported `edgePeopleSnapshotRouter`, mounted in `routes/index.ts` at `/edge-sync/people-snapshot`. Auth: `Authorization: Bearer <edge credential>`; 401 without or revoked; `Cache-Control: private, no-store`; headers `ETag` and `X-Legend-Snapshot-Generated-At`; `If-None-Match` equal to the ETag gives 304 with no body.

## Setup pattern

Copy the setup of `apps/api/src/test/edge-registry-pull.test.ts` (createApp, cloning an outlet with `asOwner` SQL, `registerEdgeNode` returning `credential`, `STARTER_TEST_RUN` guard). Seed users, staff_pins, employees, roles, role_assignments, shift_assignments, attendance_policies with owner SQL or the existing service helpers (look at hris tests for seeding examples).

## Cases (each must be a separate `it`)

1. Only outlet O data: users with `staff_pins` at O plus `user_id` of employees sent; roles referenced by assignments sent.
2. Employees: home outlet O, or a `published`/`swapped` shift at O between today-1 and today+7; status `onboarding`/`active` only (terminated, suspended excluded); employee with `user_id` NULL excluded; employee with a shift at O and home outlet P sent with `homeOutletId = O`.
3. Other tenant and other outlet data never appear (users, employees, shifts, assignments).
4. Credential of outlet B (same tenant, other outlet): response has none of outlet A's shifts or home-outlet-A-only employees.
5. Whitelist: every object key set equals the exported `EDGE_PEOPLE_SNAPSHOT_*_KEYS` exactly; JSON text contains none of: `password`, `Encrypted`, `Hmac`, `nik`, `npwp`, `bpjs`, `bank`, the real email of any user, `image`; `email` is `<id>@edge.invalid`; `assignedBy === userId`; station-scope assignment not sent; assignment with `validUntil` in the past not sent; assignment scoped to another outlet not sent; `shiftTemplateId` and `stationId` null.
6. Strictness: body parses with `edgePeopleSnapshotSchema`; a copy with an extra column on user/employee/shift fails `safeParse` (proves the contract is the guard).
7. QR day keys: `qrKeys` has dayIndex today-1..today+3 (UTC day of `now`) equal to `deriveQrDayKeys(seed, tenantId, outletId, from, 5)` base64; the seed (base64 and hex) is not in the JSON; the seed exists after the call when none existed before.
8. 304: second request with `If-None-Match` = first ETag gives 304; ETag stable across two calls with different `now` within the same minute (generatedAt not hashed); ETag changes after a shift is added; ETag changes when a day key rolls (call with `now` one UTC day later).
9. 401 without Authorization and with a revoked node (revoke through the existing registry service), also `Cache-Control` contains `no-store` on 200 and 304.
10. Selfie seal key: with env `ATTENDANCE_SELFIE_SEAL_KEYS` (JSON `{kid: PKCS#8 PEM}`) and `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID` set, `selfieSealKey` = `{kid, publicKeyPem}` (SPKI PEM, no private key text); unset gives `null`. Never `PRIVATE KEY` in the body.
11. Logging: spy on `logger` (`apps/api/src/lib/logger.ts`); after a 200, no log call contains a person name or employee number from the seed.

## Done when

File typechecks in your head against the interface above, uses only existing helpers, and every case above exists. Report the file path and any assumption you made about seeding helpers.
