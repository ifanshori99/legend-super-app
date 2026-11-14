// Emergency button relay on the outlet edge (bead legend-bod; PRD v1.7 F25
// Keselamatan, FAC-08; design docs/design/edge-emergency.md D-02..D-09, D-11).
// Part E1: EM-01, EM-07, EM-08, EM-09, EM-10, EM-14, EM-15, EM-18, EM-19,
// EM-20 and the edge allowlist cases that need a running app. Ported from the
// draft `origin/ws/bod-emergency-relay` (panic-relay.test.ts) onto m1; every
// Better Auth part of the draft (staff sign-in cookie, agent ack/list, cookie
// socket handshake) is replaced by a device + PIN receiver session (D-03).
// Written BEFORE the implementation, from the design and the shared contract
// constants (panic-test-helpers.ts), never from the implementation.
//
// Real in-process WebSocket (`ws`) for delivery. Receipt time minus
// `received_at` is asserted under PANIC_DELIVERY_BUDGET_MS.
//
// ASSUMPTIONS (the design is silent; each one is a single place to adjust):
//  - Press answers 200 or 201 for every accepted press, also a replay (D-06
//    says 200 for a replay).
//  - Session issue: POST PANIC_ROUTES.sessions with the device token header,
//    a trusted Origin and `sessionBody(userId, pin)`; the cookie
//    `legend_emergency=<tenantId>.<token>` arrives in Set-Cookie.
//  - The socket is attached to an http server by the module named in
//    PANIC_REALTIME_ATTACH (helpers file). Server frames
//    `{ type: "panic", alertId, outletId, unitId, receivedAt, kind }`; client
//    frame `{ type: "received", alertId }`.
//  - A repeated acknowledgement by the SAME staff member answers 200 (the
//    draft behaviour); a different staff member gets 409 whose body names who
//    acknowledged (user id or display name).
//  - Cloud routes use the paths in PANIC_ROUTES. Cloud list/resolve/ack need a
//    cloud session of staff holding facility.emergency.respond (ack, list) or
//    facility.emergency.resolve (resolve). The resolve body is `{ note }`.
//  - The manager list (cloud) leaves `kind = 'test'` alerts out by default
//    (EM-15 "excluded from the incident report query").
//  - Founder answers 13 Nov are final: Q94 fallback ON (no receipt in 15 s ->
//    alarm on all POS screens of the outlet, room name + time only) and Q95
//    receivers = on-duty facility attendant, supervisor, outlet manager,
//    general manager; cashier/kitchen do not receive; only outlet manager and
//    general manager resolve, in the cloud. The fallback is observable as
//    `panic_alerts.fallback_shown_at` and as the POS read route
//    PANIC_FALLBACK_ROUTE (helpers file).
//  - Fold window (60 s) cannot be crossed without a clock seam, so only the
//    "within the window" half of EM-08 is asserted.
//  - Roles are created by raw SQL with a permission list; the catalog check of
//    the new permission names (if any) is part of the work, not of this test.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import request from "supertest";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { roleTemplate, type RoleTemplateKey } from "@starter/shared/access";
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import { readPanicFallback } from "../services/panic-relay.service.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  agent,
  originHeader,
  signUp,
  verifySessionMfa,
  WEB_ORIGIN,
} from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_DELIVERY_BUDGET_MS,
  PANIC_FALLBACK_AFTER_MS,
  PANIC_FALLBACK_ITEM_KEYS,
  PANIC_FALLBACK_ROUTE,
  PANIC_NON_RECEIVER_TEMPLATES,
  PANIC_RECEIVER_ROLES,
  PANIC_RESOLVER_ROLES,
  PANIC_FRAME_ALERT,
  PANIC_FRAME_RECEIVED,
  PANIC_PERMISSION_RESOLVE,
  PANIC_PERMISSION_RESPOND,
  PANIC_PRESS_FOLD_WINDOW_MS,
  PANIC_PRESS_RATE_LIMIT_PER_MIN,
  PANIC_REALTIME_ATTACH,
  PANIC_RESEND_INTERVAL_MS,
  PANIC_ROUTES,
  PANIC_TEST_WAIT_MS,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";
const PIN = "582914";
const SLOW_MS = 45_000;
// Precondition waits in tests that do not assert the 5 s budget (EM-19): the
// delivery latency is asserted by EM-01; here a loaded machine must not fail it.
const LOAD_WAIT_MS = 30_000;

// One isolated tenant for the whole file (created in beforeAll, removed in
// afterAll): no shared fixture tenant, so no other file sees or touches it.
let tenant: IsolatedTenant;
const extraTenantIds: string[] = [];
const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp({ edgeMode: false });
const cloudState = getEdgeRuntimeState();

let tenantContext: ReturnType<typeof establishTenantContext>;
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();

// ---- cleanup registry -----------------------------------------------------

const outletIds: string[] = [];
const deviceIds: string[] = [];
const facilityIds: string[] = [];
const employeeIds: string[] = [];
const roleIds: string[] = [];
const userIds: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---- edge process + outlet world -----------------------------------------

/** This process becomes the edge node of `outletId`, with the cloud link DOWN. */
function actAsEdge(outletId: string) {
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: outletScope(outletId),
      scope: {
        tenantId: tenant.tenantId,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

const outletPeppers = new Map<string, Buffer>();
function holdEdgePepper(outlet: string) {
  let pepper = outletPeppers.get(outlet);
  if (pepper === undefined) {
    pepper = randomBytes(32);
    outletPeppers.set(outlet, pepper);
  }
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outlet, [{ version: 2, pepper }]);
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  outletIds.push(id);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        `EM-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    ),
  );
  return id;
}

/** A fresh outlet that this process serves as an offline edge: isolates every test. */
async function world(label: string) {
  const outlet = await seedOutlet(label);
  holdEdgePepper(outlet);
  actAsEdge(outlet);
  return outlet;
}

// ---- devices, rooms, staff ------------------------------------------------

async function registerPanicButton(outlet: string, label = "Tombol Kamar") {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', $4, $5)`,
      [deviceId, tenant.tenantId, outlet, label, new Date(issuedAt * 1000)],
    ),
  );
  deviceIds.push(deviceId);
  const token = signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
  return { deviceId, token, label };
}

async function enrollAt(outlet: string, type: "pos" | "waiter_phone" = "pos") {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type,
    label: `Receiver ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  deviceIds.push(enrolled.device.id);
  return { token: enrolled.token, deviceId: enrolled.device.id };
}

/** A room of `outlet` whose panic button is `panicDeviceId` (unit code P1). */
async function seedUnit(outlet: string, panicDeviceId: string) {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitId = randomUUID();
  facilityIds.push(facilityId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Panic Relay', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.tenantId,
        outlet,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Panic', 0)`,
      [areaId, tenant.tenantId, outlet, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order, panic_device_id)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'available', 0, $6)`,
      [unitId, tenant.tenantId, outlet, facilityId, areaId, panicDeviceId],
    );
  });
  return { facilityId, unitId };
}

const jakartaDateOf = (instantMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(instantMs),
  );

async function grantRole(
  userId: string,
  permissions: string[],
  outlet: string,
  templateKey?: RoleTemplateKey,
): Promise<void> {
  if (templateKey !== undefined) {
    // A seeded role template, at outlet scope when the template allows it.
    const scopeType = roleTemplate(templateKey).allowedScopeTypes.includes(
      "outlet",
    )
      ? "outlet"
      : "tenant";
    await asTenantOwner(async (client) => {
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         SELECT $1, $2, r.id, $3, $4, now() - interval '1 hour', $2
           FROM roles r WHERE r.tenant_id = $1 AND r.template_key = $5`,
        [
          tenant.tenantId,
          userId,
          scopeType,
          scopeType === "outlet" ? outlet : null,
          templateKey,
        ],
      );
    });
    return;
  }
  const roleId = randomUUID();
  roleIds.push(roleId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.tenantId,
        `Darurat ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.tenantId, userId, roleId, outlet],
    );
  });
}

type Staff = {
  userId: string;
  name: string;
  employeeId: string;
  email: string;
  client: ReturnType<typeof agent>;
};

/**
 * Staff of `outlet` with a PIN, an employee row and, by default, a clock-in 3 h
 * ago with no clock-out (on duty by D-04 (b)). `permissions` default to the
 * receiver permission.
 */
async function newStaff(
  label: string,
  outlet: string,
  options: {
    permissions?: string[];
    onDuty?: boolean;
    template?: RoleTemplateKey;
  } = {},
): Promise<Staff> {
  const client = agent(cloudApp);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const name = (session.body.user.name as string | undefined) ?? label;
  userIds.push(userId);
  await grantRole(
    userId,
    options.permissions ?? [PANIC_PERMISSION_RESPOND],
    outlet,
    options.template,
  );
  const employeeId = randomUUID();
  employeeIds.push(employeeId);
  await asTenantOwner(async (c) => {
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.tenantId,
        userId,
        `EM-${employeeId.slice(0, 8).toUpperCase()}`,
        label,
        outlet,
      ],
    );
    if (options.onDuty !== false) {
      const agoHours = 3;
      await c.query(
        `INSERT INTO attendance_logs
           (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
            validity, flag_reasons, business_date, client_event_id, review_status)
         VALUES ($1, $2, $3, $4, 'in', 'outlet_device', now() - make_interval(hours => $5::int),
                 now() - make_interval(hours => $5::int), 'valid', '[]', $6, $7, 'none')`,
        [
          ulidToUuid(createUlid()),
          tenant.tenantId,
          outlet,
          employeeId,
          agoHours,
          jakartaDateOf(Date.now() - agoHours * 3_600_000),
          createUlid(),
        ],
      );
    }
  });
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: outlet, userId },
    { pin: PIN },
  );
  return { userId, name, employeeId, email, client };
}

// ---- requests -------------------------------------------------------------

const codeOf = (res: { body: { error?: { code?: string }; code?: string } }) =>
  res.body.error?.code ?? res.body.code;

const press = (token: string | null, body: unknown) => {
  const req = request(edgeApp).post(PANIC_ROUTES.press);
  if (token) req.set(DEVICE_TOKEN_HEADER, token);
  return req.send(body as object);
};

const newEventId = () => `evt-${randomUUID()}`;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw)
    ? (raw as string[])
    : raw
      ? [String(raw)]
      : [];
  const entry = list.find((c) => c.startsWith(`${PANIC_COOKIE_NAME}=`));
  expect(entry, `Set-Cookie ${PANIC_COOKIE_NAME} missing`).toBeDefined();
  return (entry as string).split(";")[0];
}

/** Device + PIN receiver session on the edge; returns the cookie pair. */
async function openSession(staff: Staff, device: { token: string }) {
  const res = await withEdgeModeEnv(() =>
    request(edgeApp)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send(sessionBody(staff.userId, PIN)),
  );
  expect(
    [200, 201],
    `session issue answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  return cookieOf(res);
}

const sessionRequest = (staff: Staff, device: { token: string }, pin = PIN) =>
  withEdgeModeEnv(() =>
    request(edgeApp)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send(sessionBody(staff.userId, pin)),
  );

async function receiverFor(outlet: string, label: string) {
  const staff = await newStaff(label, outlet);
  const device = await enrollAt(outlet);
  const cookie = await openSession(staff, device);
  return { staff, device, cookie };
}

const ackAs = (cookie: string | null, alertId: string) => {
  const req = request(edgeApp)
    .post(PANIC_ROUTES.ack(alertId))
    .set(originHeader);
  if (cookie) req.set("Cookie", cookie);
  return req.send({});
};

// ---- real WebSocket -------------------------------------------------------

let wsServer: { server: Server; port: number } | null = null;

async function startRealtime() {
  if (wsServer) return wsServer;
  let attach: unknown;
  try {
    const mod = (await import(
      /* @vite-ignore */ PANIC_REALTIME_ATTACH.module
    )) as Record<string, unknown>;
    attach = mod[PANIC_REALTIME_ATTACH.exportName];
  } catch (error) {
    throw new Error(
      `MISSING BEHAVIOUR: ${PANIC_REALTIME_ATTACH.module} cannot be imported (${String(error)})`,
    );
  }
  if (typeof attach !== "function")
    throw new Error(
      `MISSING BEHAVIOUR: ${PANIC_REALTIME_ATTACH.module} does not export ${PANIC_REALTIME_ATTACH.exportName}`,
    );
  const server = createServer(edgeApp);
  guardEdgeUpgrades(server, { edgeMode: true });
  const realtime = (await (attach as (...a: unknown[]) => unknown)(server, {
    trustedOrigins: [WEB_ORIGIN],
  })) as { close?: () => void | Promise<void> } | undefined;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wsServer = { server, port: (server.address() as AddressInfo).port };
  cleanups.push(async () => {
    await realtime?.close?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wsServer = null;
  });
  return wsServer;
}

type Seen = { frame: Record<string, unknown>; at: number };

async function connect(
  cookie: string,
  options: { autoReceive?: boolean; autoPong?: boolean } = {},
) {
  const { port } = await startRealtime();
  const frames: Seen[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
    PANIC_WS_PROTOCOL,
    {
      headers: { Cookie: cookie, Origin: WEB_ORIGIN },
      autoPong: options.autoPong ?? true,
    },
  );
  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code)),
  );
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push({ frame, at: Date.now() });
    if (
      frame.type === PANIC_FRAME_ALERT &&
      (options.autoReceive ?? true) &&
      ws.readyState === WebSocket.OPEN
    )
      ws.send(
        JSON.stringify({
          type: PANIC_FRAME_RECEIVED,
          alertId: frame.alertId,
        }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`socket upgrade refused with ${res.statusCode}`)),
    );
    ws.once("error", (error) => reject(error));
  });
  cleanups.push(() => ws.terminate());
  const alertFrames = (alertId?: string) =>
    frames.filter(
      (f) =>
        f.frame.type === PANIC_FRAME_ALERT &&
        (alertId === undefined || f.frame.alertId === alertId),
    );
  return {
    ws,
    frames,
    closed,
    alertFrames,
    sendReceived: (alertId: string) =>
      ws.send(JSON.stringify({ type: PANIC_FRAME_RECEIVED, alertId })),
  };
}
type Socket = Awaited<ReturnType<typeof connect>>;

// ---- database reads -------------------------------------------------------

type AlertRow = {
  id: string;
  outlet_id: string;
  unit_id: string | null;
  first_device_event_id: string;
  unit_code_snapshot: string | null;
  facility_name_snapshot: string | null;
  device_label_snapshot: string | null;
  kind: string;
  triggered_at: Date | null;
  press_count: number;
  origin: string;
  link_offline: boolean;
  delivered_count: number;
  received_at: Date;
  first_delivered_at: Date | null;
  unrouted_since: Date | null;
  fallback_shown_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  ack_device_id: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

const alertsOf = async (deviceId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND device_id = $2 ORDER BY received_at, id",
        [tenant.tenantId, deviceId],
      ),
    )
  ).rows;

const alertById = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, alertId],
      ),
    )
  ).rows[0];

const pressRows = async (deviceId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<{ device_event_id: string; alert_id: string }>(
        "SELECT device_event_id, alert_id FROM panic_press_events WHERE tenant_id = $1 AND device_id = $2 ORDER BY received_at, device_event_id",
        [tenant.tenantId, deviceId],
      ),
    )
  ).rows;

const deliveriesOf = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<{
        session_id: string;
        user_id: string;
        sent_count: number;
        received_at: Date | null;
      }>(
        "SELECT session_id, user_id, sent_count, received_at FROM panic_alert_deliveries WHERE tenant_id = $1 AND alert_id = $2",
        [tenant.tenantId, alertId],
      ),
    )
  ).rows;

/** Raises one real alert at the outlet and returns it (press must be accepted). */
async function raise(
  button: { deviceId: string; token: string },
  eventId = newEventId(),
  kind: "press" | "test" = "press",
) {
  const res = await press(button.token, pressBody(eventId, { kind }));
  expect(
    [200, 201],
    `press answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  const rows = await alertsOf(button.deviceId);
  expect(
    rows.length,
    "an alert row exists after an accepted press",
  ).toBeGreaterThan(0);
  return { res, alert: rows[rows.length - 1], eventId, rows };
}

const resolveBody = (note: string) => ({ note });

// Cloud routes resolve the tenant from the Host header; the isolated tenant's
// hostname is not the default one, so cloud requests must send it.
const cloudHeaders = () => ({ ...originHeader, Host: tenant.hostname });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `prelay-${randomBytes(3).toString("hex")}`,
  );
  tenantContext = establishTenantContext({
    tenantId: tenant.tenantId,
    brandId: null,
    source: "session",
  });
  // The isolated tenant has no seeded role templates; grantRole picks them by
  // template_key, so seed the ones the Q95 cases use.
  const templateKeys = new Set<RoleTemplateKey>([
    ...PANIC_RECEIVER_ROLES,
    ...PANIC_NON_RECEIVER_TEMPLATES,
    ...PANIC_RESOLVER_ROLES,
    "facility_attendant",
    "supervisor",
  ]);
  for (const key of templateKeys) {
    const template = roleTemplate(key);
    await owner.query(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, true, $3, $4::jsonb, $5, $6::jsonb)`,
      [
        tenant.tenantId,
        template.defaultName,
        key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
  }
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  setEdgeRuntimeStateForTests(cloudState);
});

afterAll(async () => {
  // panic_alerts may refuse DELETE by trigger (D-08) and audit_logs is
  // append-only, so the owner deletes the whole tenant with triggers off.
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`,
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const tenantId of [tenant.tenantId, ...extraTenantIds]) {
      for (const { table_name } of rows)
        await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
          tenantId,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    }
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      userIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

// ===========================================================================
// EM-01 FAC-08: press with the cloud link down reaches an on-duty receiver < 5 s
// ===========================================================================

describe("EM-01 press with the cloud link down reaches the on-duty receiver", () => {
  it("EM-01 an on-duty receiver gets the alert and receipt minus received_at is under 5 s (cloud link down)", async () => {
    const outlet = await world("EM-01");
    expect(getEdgeRuntimeState().link.cloudLink).toBe("disconnected");
    const button = await registerPanicButton(outlet);
    const { unitId } = await seedUnit(outlet, button.deviceId);
    const rcv = await receiverFor(outlet, "EM01 Receiver");
    const sock = await connect(rcv.cookie);
    const triggeredAt = new Date().toISOString();
    const eventId = newEventId();

    const res = await press(button.token, pressBody(eventId, { triggeredAt }));
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    await vi.waitFor(() => expect(sock.alertFrames()).toHaveLength(1), {
      timeout: PANIC_DELIVERY_BUDGET_MS,
    });

    const rows = await alertsOf(button.deviceId);
    expect(rows).toHaveLength(1);
    const alert = rows[0];
    const frame = sock.alertFrames()[0];
    const toReceipt = frame.at - alert.received_at.getTime();
    expect(toReceipt).toBeLessThan(PANIC_DELIVERY_BUDGET_MS);
    expect(toReceipt).toBeGreaterThan(-1_000);

    expect(frame.frame).toMatchObject({
      type: PANIC_FRAME_ALERT,
      alertId: alert.id,
      outletId: outlet,
      unitId,
      unitCode: "P1",
      areaName: "Area Panic",
      receivedAt: expect.any(String),
    });
    expect(alert).toMatchObject({
      outlet_id: outlet,
      unit_id: unitId,
      first_device_event_id: eventId,
      unit_code_snapshot: "P1",
      facility_name_snapshot: "Panic Relay",
      device_label_snapshot: button.label,
      kind: "press",
      press_count: 1,
      origin: "edge",
      link_offline: true,
    });
    expect(alert.triggered_at?.toISOString()).toBe(triggeredAt);

    // FAC-08 proof: the receipt (client frame) is stored per recipient and per alert.
    await vi.waitFor(
      async () => {
        const stored = await alertById(alert.id);
        expect(stored.first_delivered_at).not.toBeNull();
        expect(stored.delivered_count).toBe(1);
      },
      { timeout: PANIC_DELIVERY_BUDGET_MS },
    );
    const stored = await alertById(alert.id);
    expect(
      (stored.first_delivered_at as Date).getTime() -
        stored.received_at.getTime(),
    ).toBeLessThan(PANIC_DELIVERY_BUDGET_MS);
    const deliveries = await deliveriesOf(alert.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ user_id: rcv.staff.userId });
    expect(deliveries[0].received_at).not.toBeNull();
    expect(deliveries[0].sent_count).toBeGreaterThanOrEqual(1);
  });

  it("EM-01 a button that is not mapped to a room still raises and delivers the alert with the device label", async () => {
    const outlet = await world("EM-01 unmapped");
    const button = await registerPanicButton(outlet, "Tombol Lorong");
    const rcv = await receiverFor(outlet, "EM01 Unmapped");
    const sock = await connect(rcv.cookie);

    const { alert } = await raise(button);
    await vi.waitFor(() => expect(sock.alertFrames(alert.id)).toHaveLength(1), {
      timeout: PANIC_TEST_WAIT_MS,
    });
    expect(alert.unit_id).toBeNull();
    expect(alert.device_label_snapshot).toBe("Tombol Lorong");
    expect(sock.alertFrames(alert.id)[0].frame).toMatchObject({ unitId: null });
  });

  it("EM-01 two on-duty receivers each get the alert and delivered_count counts both receipts", async () => {
    const outlet = await world("EM-01 two");
    const button = await registerPanicButton(outlet);
    const one = await receiverFor(outlet, "EM01 One");
    const two = await receiverFor(outlet, "EM01 Two");
    const sockOne = await connect(one.cookie);
    const sockTwo = await connect(two.cookie);

    const { alert } = await raise(button);
    await vi.waitFor(
      () => {
        expect(sockOne.alertFrames(alert.id)).toHaveLength(1);
        expect(sockTwo.alertFrames(alert.id)).toHaveLength(1);
      },
      { timeout: PANIC_TEST_WAIT_MS },
    );
    await vi.waitFor(
      async () => expect((await alertById(alert.id)).delivered_count).toBe(2),
      { timeout: PANIC_TEST_WAIT_MS },
    );
    expect(await deliveriesOf(alert.id)).toHaveLength(2);
  }, 30_000);

  it("EM-01 refuses a device that is not a panic button and stores nothing", async () => {
    const outlet = await world("EM-01 not a button");
    const pos = await enrollAt(outlet);
    const res = await press(pos.token, pressBody(newEventId()));
    // ASSUMPTION: 401, 403 or 422 (the design only says "device.type = panic_button").
    expect([401, 403, 422]).toContain(res.status);
    expect(await alertsOf(pos.deviceId)).toHaveLength(0);
  });

  it("EM-01 refuses a panic button registered in another outlet with 401 and no hint (D-10)", async () => {
    const outlet = await world("EM-01 node");
    const other = await seedOutlet("EM-01 other");
    const stranger = await registerPanicButton(other);
    const res = await press(stranger.token, pressBody(newEventId()));
    expect(res.status).toBe(401);
    expect(await alertsOf(stranger.deviceId)).toHaveLength(0);
    expect(outlet).not.toBe(other);
  });

  it("EM-01 answers 401 without a device token and 401 or 403 with a forged one", async () => {
    const outlet = await world("EM-01 token");
    const button = await registerPanicButton(outlet);
    expect((await press(null, pressBody(newEventId()))).status).toBe(401);
    const forged = await press("dv1.forged.token", pressBody(newEventId()));
    expect([401, 403]).toContain(forged.status);
    expect(await alertsOf(button.deviceId)).toHaveLength(0);
  });

  it("EM-01 rejects a malformed or over-posted body (strict) and stores nothing", async () => {
    const outlet = await world("EM-01 strict");
    const button = await registerPanicButton(outlet);
    const good = pressBody(newEventId());
    for (const bad of [
      {},
      { ...good, eventId: "" },
      { ...good, eventId: "x".repeat(65) },
      { ...good, triggeredAt: "yesterday-ish" },
      { ...good, kind: "alarm" },
      { ...good, outletId: outlet },
      { ...good, tenantId: tenant.tenantId },
      { ...good, deviceId: button.deviceId },
    ]) {
      const res = await press(button.token, bad);
      expect([400, 422], JSON.stringify(bad)).toContain(res.status);
    }
    expect(await alertsOf(button.deviceId)).toHaveLength(0);
  });
});

// ===========================================================================
// Q95 (founder answer, final): who receives and who resolves
// ===========================================================================

describe("EM-01 Q95 receivers are facility attendant, supervisor, outlet manager, general manager", () => {
  it("EM-01 Q95 the role templates: the four receiver roles hold facility.emergency.respond, cashier and kitchen do not; only outlet and general manager hold facility.emergency.resolve", () => {
    const holds = (key: RoleTemplateKey, code: string) =>
      (roleTemplate(key).permissions as readonly string[]).includes(code);
    for (const key of PANIC_RECEIVER_ROLES)
      expect(holds(key, PANIC_PERMISSION_RESPOND), `${key} receives`).toBe(
        true,
      );
    for (const key of PANIC_NON_RECEIVER_TEMPLATES)
      expect(
        holds(key, PANIC_PERMISSION_RESPOND),
        `${key} must not receive`,
      ).toBe(false);
    for (const key of PANIC_RESOLVER_ROLES)
      expect(holds(key, PANIC_PERMISSION_RESOLVE), `${key} resolves`).toBe(
        true,
      );
    for (const key of [
      "facility_attendant",
      "supervisor",
      ...PANIC_NON_RECEIVER_TEMPLATES,
    ] as RoleTemplateKey[])
      expect(
        holds(key, PANIC_PERMISSION_RESOLVE),
        `${key} must not resolve`,
      ).toBe(false);
  });

  it("EM-01 Q95 on-duty staff with a receiver role template get a session and the alert; cashier and kitchen get 403 and nothing", async () => {
    const outlet = await world("EM-01 Q95");
    const button = await registerPanicButton(outlet);
    const sockets: Array<{ key: string; sock: Socket }> = [];
    for (const key of PANIC_RECEIVER_ROLES) {
      const staff = await newStaff(`Q95 ${key}`, outlet, { template: key });
      const device = await enrollAt(outlet);
      const res = await sessionRequest(staff, device);
      expect(
        [200, 201],
        `${key}: ${res.status} ${JSON.stringify(res.body)}`,
      ).toContain(res.status);
      sockets.push({ key, sock: await connect(cookieOf(res)) });
    }
    for (const key of PANIC_NON_RECEIVER_TEMPLATES) {
      const staff = await newStaff(`Q95 ${key}`, outlet, { template: key });
      const device = await enrollAt(outlet);
      const res = await sessionRequest(staff, device);
      expect(res.status, `${key} must not get a session`).toBe(403);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }

    const { alert } = await raise(button);
    await vi.waitFor(
      () => {
        for (const { key, sock } of sockets)
          expect(sock.alertFrames(alert.id), key).toHaveLength(1);
      },
      { timeout: PANIC_TEST_WAIT_MS },
    );
    await vi.waitFor(
      async () =>
        expect((await alertById(alert.id)).delivered_count).toBe(
          PANIC_RECEIVER_ROLES.length,
        ),
      { timeout: PANIC_TEST_WAIT_MS },
    );
  }, 30_000);
});

// ===========================================================================
// EM-07 / EM-18 duplicate press and retry
// ===========================================================================

describe("EM-07 same device event twice makes one alert and re-publishes while open", () => {
  it(
    "EM-07 a replay of the same eventId makes one alert, one press row and shows it again until acknowledged",
    async () => {
      const outlet = await world("EM-07");
      const button = await registerPanicButton(outlet);
      await seedUnit(outlet, button.deviceId);
      const barrier = await registerPanicButton(outlet, "Tombol Penanda");
      const rcv = await receiverFor(outlet, "EM07 Receiver");
      const sock = await connect(rcv.cookie);
      const eventId = newEventId();

      const first = await raise(button, eventId);
      await vi.waitFor(
        () => expect(sock.alertFrames(first.alert.id)).toHaveLength(1),
        {
          timeout: PANIC_TEST_WAIT_MS,
        },
      );

      const replay = await press(button.token, pressBody(eventId));
      expect([200, 201]).toContain(replay.status);
      const again = await alertsOf(button.deviceId);
      expect(again).toHaveLength(1);
      expect(again[0].id).toBe(first.alert.id);
      expect(again[0].press_count).toBe(1);
      expect(await pressRows(button.deviceId)).toEqual([
        { device_event_id: eventId, alert_id: first.alert.id },
      ]);
      // Re-published to the receiver while nobody acknowledged.
      await vi.waitFor(
        () =>
          expect(
            sock.alertFrames(first.alert.id).length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: PANIC_TEST_WAIT_MS },
      );

      expect(sock.alertFrames(first.alert.id)[1].frame).toMatchObject({
        unitCode: "P1",
        areaName: "Area Panic",
      });

      expect([200, 201]).toContain(
        (await press(button.token, pressBody(newEventId()))).status,
      );
      await vi.waitFor(() =>
        expect(sock.alertFrames(first.alert.id).length).toBeGreaterThanOrEqual(
          3,
        ),
      );
      expect(sock.alertFrames(first.alert.id)[2].frame).toMatchObject({
        unitCode: "P1",
        areaName: "Area Panic",
      });

      expect((await ackAs(rcv.cookie, first.alert.id)).status).toBe(200);
      const shownBefore = sock.alertFrames(first.alert.id).length;

      // After the acknowledgement a replay is answered but not shown again. A press
      // of another button is the ordered barrier: frames arrive in publish order.
      const late = await press(button.token, pressBody(eventId));
      expect([200, 201]).toContain(late.status);
      const marker = await raise(barrier);
      await vi.waitFor(
        () =>
          expect(sock.alertFrames(marker.alert.id).length).toBeGreaterThan(0),
        {
          timeout: PANIC_TEST_WAIT_MS,
        },
      );
      expect(sock.alertFrames(first.alert.id)).toHaveLength(shownBefore);
      expect(await alertsOf(button.deviceId)).toHaveLength(1);
    },
    SLOW_MS,
  );

  it("EM-07 a new eventId after the first press is folded, not a second alert (see EM-08)", async () => {
    const outlet = await world("EM-07 new id");
    const button = await registerPanicButton(outlet);
    const first = await raise(button);
    const second = await press(button.token, pressBody(newEventId()));
    expect([200, 201]).toContain(second.status);
    const rows = await alertsOf(button.deviceId);
    expect(rows.map((r) => r.id)).toEqual([first.alert.id]);
  });
});

describe("EM-18 a button retry after acknowledgement returns the same alert", () => {
  it("EM-18 retrying the same eventId after the acknowledgement is 200, the same alert, nothing changed", async () => {
    const outlet = await world("EM-18");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM18 Receiver");
    const { alert, eventId } = await raise(button);
    expect((await ackAs(rcv.cookie, alert.id)).status).toBe(200);
    const acked = await alertById(alert.id);
    expect(acked.acknowledged_by).toBe(rcv.staff.userId);

    const retry = await press(button.token, pressBody(eventId));
    expect(retry.status).toBe(200);
    expect(JSON.stringify(retry.body)).toContain(alert.id);

    const rows = await alertsOf(button.deviceId);
    expect(rows.map((r) => r.id)).toEqual([alert.id]);
    const after = await alertById(alert.id);
    expect(after.acknowledged_by).toBe(rcv.staff.userId);
    expect(after.acknowledged_at?.getTime()).toBe(
      acked.acknowledged_at?.getTime(),
    );
    expect(after.press_count).toBe(1);
    expect(await pressRows(button.deviceId)).toHaveLength(1);
  });

  it("EM-18 the alert id is deterministic: a device and first eventId map to one stable id", async () => {
    const outlet = await world("EM-18 id");
    const button = await registerPanicButton(outlet);
    const eventId = newEventId();
    const first = await raise(button, eventId);
    const again = await press(button.token, pressBody(eventId));
    expect([200, 201]).toContain(again.status);
    expect(first.alert.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Version nibble "5" like uuid v5 (D-06: version bits set like v5).
    expect(first.alert.id[14]).toBe("5");
    expect((await alertsOf(button.deviceId))[0].id).toBe(first.alert.id);
  });
});

// ===========================================================================
// EM-08 second press folded
// ===========================================================================

describe("EM-08 a second press within 60 s folds into the same alert", () => {
  it(`EM-08 second press within ${PANIC_PRESS_FOLD_WINDOW_MS / 1000} s: same alert, press_count 2, two press rows`, async () => {
    const outlet = await world("EM-08");
    const button = await registerPanicButton(outlet);
    const first = await raise(button);
    const second = await press(button.token, pressBody(newEventId()));
    expect([200, 201]).toContain(second.status);
    expect(JSON.stringify(second.body)).toContain(first.alert.id);

    const rows = await alertsOf(button.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.alert.id);
    expect(rows[0].press_count).toBe(2);
    const presses = await pressRows(button.deviceId);
    expect(presses).toHaveLength(2);
    expect(new Set(presses.map((p) => p.alert_id))).toEqual(
      new Set([first.alert.id]),
    );
  });

  it("EM-08 once the alert is acknowledged a new press is a new alert", async () => {
    const outlet = await world("EM-08 after ack");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM08 Receiver");
    const first = await raise(button);
    expect((await ackAs(rcv.cookie, first.alert.id)).status).toBe(200);
    const second = await raise(button);
    expect(second.alert.id).not.toBe(first.alert.id);
    expect(await alertsOf(button.deviceId)).toHaveLength(2);
  });

  it(`EM-08 more than ${PANIC_PRESS_RATE_LIMIT_PER_MIN} presses per minute from one device: 429, the stored alert stays live`, async () => {
    const outlet = await world("EM-08 flood");
    const button = await registerPanicButton(outlet);
    const quiet = await registerPanicButton(outlet, "Tombol Tenang");
    const statuses: number[] = [];
    for (let i = 0; i < PANIC_PRESS_RATE_LIMIT_PER_MIN + 5; i += 1)
      statuses.push(
        (await press(button.token, pressBody(newEventId()))).status,
      );

    expect(
      statuses
        .slice(0, PANIC_PRESS_RATE_LIMIT_PER_MIN)
        .every((s) => s === 200 || s === 201),
    ).toBe(true);
    expect(
      statuses.slice(PANIC_PRESS_RATE_LIMIT_PER_MIN).every((s) => s === 429),
    ).toBe(true);

    const rows = await alertsOf(button.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].press_count).toBe(PANIC_PRESS_RATE_LIMIT_PER_MIN);
    expect(rows[0].acknowledged_at).toBeNull();
    // The limit is per device: another button still works.
    expect([200, 201]).toContain(
      (await press(quiet.token, pressBody(newEventId()))).status,
    );
  }, 30_000);
});

// ===========================================================================
// EM-09 resend every 3 s, late socket, heartbeat
// ===========================================================================

describe("EM-09 resend until receipt, late sockets, heartbeat", () => {
  it(
    `EM-09 resends about every ${PANIC_RESEND_INTERVAL_MS / 1000} s until the receiver sends "received", then stops`,
    async () => {
      const outlet = await world("EM-09 resend");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "EM09 Receiver");
      const sock = await connect(rcv.cookie, { autoReceive: false });

      const { alert } = await raise(button);
      await vi.waitFor(
        () =>
          expect(sock.alertFrames(alert.id).length).toBeGreaterThanOrEqual(3),
        { timeout: 4 * PANIC_RESEND_INTERVAL_MS },
      );
      const times = sock.alertFrames(alert.id).map((f) => f.at);
      for (let i = 1; i < 3; i += 1) {
        const gap = times[i] - times[i - 1];
        expect(gap).toBeGreaterThan(PANIC_RESEND_INTERVAL_MS - 1_000);
        expect(gap).toBeLessThan(PANIC_RESEND_INTERVAL_MS + 1_500);
      }
      // The first frame is not delayed by the resend loop (FAC-08).
      expect(times[0] - alert.received_at.getTime()).toBeLessThan(
        PANIC_DELIVERY_BUDGET_MS,
      );

      sock.sendReceived(alert.id);
      await vi.waitFor(
        async () =>
          expect((await deliveriesOf(alert.id))[0]?.received_at).not.toBeNull(),
        { timeout: PANIC_TEST_WAIT_MS },
      );
      const settled = sock.alertFrames(alert.id).length;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, PANIC_RESEND_INTERVAL_MS + 1_500),
      );
      // At most one frame that was already in flight when the receipt landed.
      expect(sock.alertFrames(alert.id).length).toBeLessThanOrEqual(
        settled + 1,
      );
    },
    SLOW_MS,
  );

  it("EM-09 a socket that connects later gets the open alert at once; an acknowledged alert is not sent", async () => {
    const outlet = await world("EM-09 late");
    const open = await registerPanicButton(outlet);
    const done = await registerPanicButton(outlet, "Tombol Selesai");
    const rcv = await receiverFor(outlet, "EM09 Late");
    const { alert: openAlert } = await raise(open);
    const { alert: doneAlert } = await raise(done);
    expect((await ackAs(rcv.cookie, doneAlert.id)).status).toBe(200);

    const connectedAt = Date.now();
    const sock = await connect(rcv.cookie);
    await vi.waitFor(
      () => expect(sock.alertFrames(openAlert.id).length).toBeGreaterThan(0),
      {
        timeout: PANIC_RESEND_INTERVAL_MS,
      },
    );
    expect(sock.alertFrames(openAlert.id)[0].at - connectedAt).toBeLessThan(
      PANIC_RESEND_INTERVAL_MS,
    );
    expect(sock.alertFrames(doneAlert.id)).toHaveLength(0);
  });

  it(
    "EM-09 heartbeat: a socket that never answers a ping is dropped (1006); one that answers stays open",
    async () => {
      const outlet = await world("EM-09 heartbeat");
      const dead = await receiverFor(outlet, "EM09 Dead");
      const live = await receiverFor(outlet, "EM09 Live");
      const silent = await connect(dead.cookie, { autoPong: false });
      const answering = await connect(live.cookie, { autoPong: true });

      // Design D-05: ping every 10 s, no pong for 25 s drops the socket.
      expect(await silent.closed).toBe(1006);
      expect(answering.ws.readyState).toBe(WebSocket.OPEN);
    },
    SLOW_MS,
  );
});

// ===========================================================================
// EM-10 first acknowledgement wins
// ===========================================================================

describe("EM-10 two acknowledgements: first wins, second gets 409", () => {
  it("legend-5egl3 sends acknowledgement to another connected recipient", async () => {
    const outlet = await world("EM-10 broadcast");
    const button = await registerPanicButton(outlet);
    const first = await receiverFor(outlet, "EM10 Broadcast First");
    const second = await receiverFor(outlet, "EM10 Broadcast Second");
    const sock = await connect(second.cookie);
    const { alert } = await raise(button);
    await vi.waitFor(() => expect(sock.alertFrames(alert.id)).toHaveLength(1));
    expect((await ackAs(first.cookie, alert.id)).status).toBe(200);
    await vi.waitFor(
      () => {
        expect(sock.frames.map(({ frame }) => frame)).toContainEqual({
          type: "acknowledged",
          alertId: alert.id,
          acknowledgedAt: expect.any(String),
          byName: first.staff.name,
        });
      },
      { timeout: PANIC_TEST_WAIT_MS },
    );
  });

  it("legend-td6pj returns the responder in structured 409 data without their user id", async () => {
    const outlet = await world("EM-10 conflict details");
    const button = await registerPanicButton(outlet);
    const first = await receiverFor(outlet, "EM10 Conflict First");
    const second = await receiverFor(outlet, "EM10 Conflict Second");
    const { alert } = await raise(button);
    expect((await ackAs(first.cookie, alert.id)).status).toBe(200);
    const late = await ackAs(second.cookie, alert.id);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: "PANIC_ALREADY_ACKNOWLEDGED",
      acknowledgedBy: { displayName: first.staff.name },
      acknowledgedAt: expect.any(String),
    });
    expect(late.body.error.message).not.toContain(first.staff.userId);
  });

  it("EM-10 the first receiver wins, a second gets 409 naming who acknowledged, the winner may repeat; response time stored", async () => {
    const outlet = await world("EM-10");
    const button = await registerPanicButton(outlet);
    const first = await receiverFor(outlet, "EM10 First");
    const second = await receiverFor(outlet, "EM10 Second");
    const { alert } = await raise(button);

    const win = await ackAs(first.cookie, alert.id);
    expect(win.status, JSON.stringify(win.body)).toBe(200);
    const late = await ackAs(second.cookie, alert.id);
    expect(late.status).toBe(409);
    const body = JSON.stringify(late.body);
    expect(
      body.includes(first.staff.userId) || body.includes(first.staff.name),
      `409 body names the acknowledger: ${body}`,
    ).toBe(true);
    expect((await ackAs(first.cookie, alert.id)).status).toBe(200);

    const stored = await alertById(alert.id);
    expect(stored.acknowledged_by).toBe(first.staff.userId);
    expect(stored.ack_device_id).toBe(first.device.deviceId);
    // Response time = acknowledged_at - received_at, never negative.
    const responseMs =
      (stored.acknowledged_at as Date).getTime() - stored.received_at.getTime();
    expect(responseMs).toBeGreaterThanOrEqual(0);
    expect(responseMs).toBeLessThan(30_000);
  });

  it("EM-10 an acknowledgement needs a receiver session (401) and an existing alert in the outlet (404)", async () => {
    const outlet = await world("EM-10 guards");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM10 Guards");
    const { alert } = await raise(button);

    expect((await ackAs(null, alert.id)).status).toBe(401);
    expect((await ackAs(rcv.cookie, randomUUID())).status).toBe(404);
    expect((await alertById(alert.id)).acknowledged_by).toBeNull();
  });

  it("EM-10 an alert of another outlet cannot be acknowledged with this outlet's session (404)", async () => {
    const outlet = await world("EM-10 outlet A");
    const rcv = await receiverFor(outlet, "EM10 Outlet A");
    const other = await seedOutlet("EM-10 outlet B");
    const stranger = await registerPanicButton(other);
    // The alert exists in the shared database but belongs to outlet B.
    const rows = await asTenantOwner((c) =>
      c.query<{ id: string }>(
        "SELECT id FROM panic_alerts WHERE tenant_id = $1 AND device_id = $2",
        [tenant.tenantId, stranger.deviceId],
      ),
    );
    expect(rows.rows).toHaveLength(0);
    actAsEdge(other);
    const raised = await raise(stranger);
    actAsEdge(outlet);
    const res = await ackAs(rcv.cookie, raised.alert.id);
    expect(res.status).toBe(404);
    expect((await alertById(raised.alert.id)).acknowledged_by).toBeNull();
  });

  it("EM-10 a cloud acknowledgement by staff with cloud auth also wins; a later edge acknowledgement gets 409", async () => {
    const outlet = await world("EM-10 cloud");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM10 Edge");
    const manager = await newStaff("EM10 Cloud", outlet, {
      permissions: [PANIC_PERMISSION_RESPOND],
      onDuty: false,
    });
    const { alert } = await raise(button);

    setEdgeRuntimeStateForTests(cloudState);
    const cloud = await manager.client
      .post(PANIC_ROUTES.cloudAck(outlet, alert.id))
      .set(cloudHeaders())
      .send({});
    expect(cloud.status, JSON.stringify(cloud.body)).toBe(200);
    expect((await alertById(alert.id)).acknowledged_by).toBe(manager.userId);

    actAsEdge(outlet);
    expect((await ackAs(rcv.cookie, alert.id)).status).toBe(409);
  });
});

describe("legend-2sr38 receiver can restore open alerts", () => {
  it("returns only unacknowledged alerts in the receiver outlet after reload", async () => {
    const outlet = await world("restore A");
    const receiver = await receiverFor(outlet, "Restore A Receiver");
    const button = await registerPanicButton(outlet);
    await seedUnit(outlet, button.deviceId);
    const { alert } = await raise(button);
    const closedButton = await registerPanicButton(outlet);
    const closed = await raise(closedButton);
    expect((await ackAs(receiver.cookie, closed.alert.id)).status).toBe(200);
    const resolvedButton = await registerPanicButton(outlet);
    const resolved = await raise(resolvedButton);
    await asTenantOwner((client) =>
      client.query(
        "UPDATE panic_alerts SET resolved_at = now(), resolved_by = $3 WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, resolved.alert.id, receiver.staff.userId],
      ),
    );

    const other = await world("restore B");
    const otherButton = await registerPanicButton(other);
    const otherAlert = await raise(otherButton);
    actAsEdge(outlet);

    const foreignTenant = await createIsolatedTenant(
      `panic-foreign-${randomBytes(3).toString("hex")}`,
    );
    extraTenantIds.push(foreignTenant.tenantId);
    const foreignOutlet = randomUUID();
    const foreignAlert = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'FOREIGN', 'Foreign', 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        foreignOutlet,
        foreignTenant.tenantId,
        foreignTenant.brandId,
        foreignTenant.legalEntityId,
      ],
    );
    await owner.query(
      `INSERT INTO panic_alerts (tenant_id, id, outlet_id, device_id, first_device_event_id, unit_code_snapshot, facility_name_snapshot, device_label_snapshot)
       VALUES ($1, $2, $3, $4, 'foreign-event', 'F1', 'Foreign', 'Foreign button')`,
      [foreignTenant.tenantId, foreignAlert, foreignOutlet, randomUUID()],
    );

    const res = await request(edgeApp)
      .get("/api/emergency/open-alerts")
      .set("Cookie", receiver.cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.alerts).toEqual([
      expect.objectContaining({
        type: "panic",
        alertId: alert.id,
        unitCode: "P1",
        areaName: "Area Panic",
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(closed.alert.id);
    expect(JSON.stringify(res.body)).not.toContain(resolved.alert.id);
    expect(JSON.stringify(res.body)).not.toContain(otherAlert.alert.id);
    expect(JSON.stringify(res.body)).not.toContain(foreignAlert);
    expect(
      (await request(edgeApp).get("/api/emergency/open-alerts")).status,
    ).toBe(401);
    await asTenantOwner((client) =>
      client.query(
        "UPDATE panic_receiver_sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE tenant_id = $1 AND user_id = $2",
        [tenant.tenantId, receiver.staff.userId],
      ),
    );
    expect(
      (
        await request(edgeApp)
          .get("/api/emergency/open-alerts")
          .set("Cookie", receiver.cookie)
      ).status,
    ).toBe(401);
  });
});

// ===========================================================================
// EM-14 / EM-19 fallback (QE1) and unrouted alerts
// ===========================================================================

describe("EM-14 nobody connected: unrouted_since is set, the fallback fires after 15 s", () => {
  it("EM-14 an alert with nobody connected records unrouted_since and is delivered to a socket that connects later", async () => {
    const outlet = await world("EM-14 unrouted");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM14 Receiver"); // session, but no socket
    const { alert } = await raise(button);

    expect(alert.unrouted_since).not.toBeNull();
    expect(alert.fallback_shown_at).toBeNull();
    expect(alert.first_delivered_at).toBeNull();
    expect(alert.delivered_count).toBe(0);

    const sock = await connect(rcv.cookie);
    await vi.waitFor(
      () => expect(sock.alertFrames(alert.id).length).toBeGreaterThan(0),
      {
        timeout: PANIC_RESEND_INTERVAL_MS,
      },
    );
  });

  it(
    `EM-14 (QE1 yes) with nobody connected the POS fallback fires after ${PANIC_FALLBACK_AFTER_MS / 1000} s`,
    async () => {
      const outlet = await world("EM-14 fallback");
      const button = await registerPanicButton(outlet);
      const { alert } = await raise(button);
      expect(alert.fallback_shown_at).toBeNull();

      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).fallback_shown_at).not.toBeNull(),
        { timeout: PANIC_FALLBACK_AFTER_MS + 5_000, interval: 500 },
      );
      const stored = await alertById(alert.id);
      const after =
        (stored.fallback_shown_at as Date).getTime() -
        stored.received_at.getTime();
      expect(after).toBeGreaterThanOrEqual(PANIC_FALLBACK_AFTER_MS - 1_000);
      expect(after).toBeLessThan(PANIC_FALLBACK_AFTER_MS + 5_000);
      expect(stored.acknowledged_at).toBeNull();
    },
    SLOW_MS,
  );

  it(
    "EM-14 (Q94) after 15 s without a receipt every POS screen of the outlet shows the alarm: room and time only, also without a PIN login; other outlets and acknowledged alarms do not",
    async () => {
      const outlet = await world("EM-14 pos screen");
      const other = await seedOutlet("EM-14 other outlet");
      const button = await registerPanicButton(outlet);
      const { unitId } = await seedUnit(outlet, button.deviceId);
      void unitId;
      const rcv = await receiverFor(outlet, "EM14 Acker");
      const posOne = await enrollAt(outlet);
      const posTwo = await enrollAt(outlet);
      const posElsewhere = await enrollAt(other);
      const readFallback = (token: string) =>
        request(edgeApp)
          .get(PANIC_FALLBACK_ROUTE)
          .set(DEVICE_TOKEN_HEADER, token);
      const itemsOf = (res: { body: { data?: { alerts?: unknown[] } } }) =>
        (res.body.data?.alerts ?? []) as Array<Record<string, unknown>>;

      const { alert } = await raise(button);
      // Before the deadline the POS screens show nothing.
      const early = await readFallback(posOne.token);
      expect(early.status, JSON.stringify(early.body)).toBe(200);
      expect(itemsOf(early)).toHaveLength(0);

      await vi.waitFor(
        async () => {
          const res = await readFallback(posOne.token);
          expect(itemsOf(res).map((i) => i.alertId)).toEqual([alert.id]);
        },
        { timeout: PANIC_FALLBACK_AFTER_MS + 5_000, interval: 500 },
      );
      for (const pos of [posOne, posTwo]) {
        const items = itemsOf(await readFallback(pos.token));
        expect(items).toHaveLength(1);
        // Room name + time only (Q94): no device label, no staff, no guest data.
        expect(Object.keys(items[0]).sort()).toEqual(
          [...PANIC_FALLBACK_ITEM_KEYS].sort(),
        );
        expect(items[0]).toMatchObject({ alertId: alert.id, unitCode: "P1" });
      }
      expect(itemsOf(await readFallback(posElsewhere.token))).toHaveLength(0);

      // Someone takes it: the POS screens stop showing the alarm.
      expect((await ackAs(rcv.cookie, alert.id)).status).toBe(200);
      expect(itemsOf(await readFallback(posOne.token))).toHaveLength(0);
    },
    SLOW_MS,
  );
});

describe("EM-19 a socket that never sends received triggers the fallback at 15 s", () => {
  // No wall-clock wait: readPanicFallback takes a `now` (the same hook the
  // route leaves at "now"), so the 15 s deadline is crossed by passing a later
  // clock. A POS read stamps fallback_shown_at with that `now`.
  const readFallbackAt = (deviceId: string, now: Date) =>
    readPanicFallback(tenantContext, deviceId, now);

  it(
    "EM-19 (QE1 yes) a connected but silent socket is not unrouted, and the fallback still fires at 15 s",
    async () => {
      const outlet = await world("EM-19 silent");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "EM19 Silent");
      const pos = await enrollAt(outlet);
      const sock = await connect(rcv.cookie, { autoReceive: false });
      const { alert } = await raise(button);

      await vi.waitFor(
        () => expect(sock.alertFrames(alert.id).length).toBeGreaterThan(0),
        { timeout: LOAD_WAIT_MS },
      );
      expect(alert.unrouted_since).toBeNull();
      expect((await alertById(alert.id)).fallback_shown_at).toBeNull();

      // Just before the deadline: nothing shows.
      const beforeDeadline = new Date(
        alert.received_at.getTime() + PANIC_FALLBACK_AFTER_MS - 1_000,
      );
      expect(await readFallbackAt(pos.deviceId, beforeDeadline)).toHaveLength(
        0,
      );
      expect((await alertById(alert.id)).fallback_shown_at).toBeNull();

      // At the deadline the silent socket did not stop the fallback.
      const atDeadline = new Date(
        alert.received_at.getTime() + PANIC_FALLBACK_AFTER_MS,
      );
      const items = await readFallbackAt(pos.deviceId, atDeadline);
      expect(items.map((item) => item.alertId)).toEqual([alert.id]);
      const stored = await alertById(alert.id);
      expect(stored.fallback_shown_at).not.toBeNull();
      expect(
        (stored.fallback_shown_at as Date).getTime() -
          stored.received_at.getTime(),
      ).toBe(PANIC_FALLBACK_AFTER_MS);
      expect(stored.first_delivered_at).toBeNull();
    },
    SLOW_MS,
  );

  it(
    "EM-19 (Q94) an automatic receipt of a phone before the deadline does not stop the fallback: only a human ack does",
    async () => {
      const outlet = await world("EM-19 received");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "EM19 Received");
      const pos = await enrollAt(outlet);
      const sock = await connect(rcv.cookie, { autoReceive: true });
      const { alert } = await raise(button);
      // Event-driven first: the phone got the frame. Then the stored receipt.
      // Neither is the FAC-08 5 s SLO (EM-01 asserts that), so the wait is the
      // test bound, not PANIC_DELIVERY_BUDGET_MS.
      await vi.waitFor(
        () => expect(sock.alertFrames(alert.id).length).toBeGreaterThan(0),
        { timeout: PANIC_TEST_WAIT_MS },
      );
      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).first_delivered_at).not.toBeNull(),
        { timeout: LOAD_WAIT_MS },
      );

      // Q94: the phone's automatic receipt is not a human ack; no ack in 15 s
      // means the alarm shows on the POS screens anyway.
      const atDeadline = new Date(
        alert.received_at.getTime() + PANIC_FALLBACK_AFTER_MS,
      );
      const items = await readFallbackAt(pos.deviceId, atDeadline);
      expect(items.map((item) => item.alertId)).toEqual([alert.id]);
      expect((await alertById(alert.id)).fallback_shown_at).not.toBeNull();
    },
    SLOW_MS,
  );
});

// ===========================================================================
// EM-15 test press
// ===========================================================================

describe("EM-15 a test press rings with UJI and stays out of the incident report", () => {
  it("EM-15 a test press is stored as kind test, rung with the test flag, and left out of the manager list", async () => {
    const outlet = await world("EM-15");
    const button = await registerPanicButton(outlet);
    const real = await registerPanicButton(outlet, "Tombol Nyata");
    const rcv = await receiverFor(outlet, "EM15 Receiver");
    const sock = await connect(rcv.cookie);
    const reader = await newStaff("EM15 Reader", outlet, {
      permissions: [PANIC_PERMISSION_RESPOND, PANIC_PERMISSION_RESOLVE],
      onDuty: false,
    });

    const test = await raise(button, newEventId(), "test");
    const live = await raise(real);
    await vi.waitFor(
      () => {
        expect(sock.alertFrames(test.alert.id)).toHaveLength(1);
        expect(sock.alertFrames(live.alert.id)).toHaveLength(1);
      },
      { timeout: PANIC_TEST_WAIT_MS },
    );
    expect(test.alert.kind).toBe("test");
    expect(sock.alertFrames(test.alert.id)[0].frame).toMatchObject({
      kind: "test",
    });
    expect(sock.alertFrames(live.alert.id)[0].frame).toMatchObject({
      kind: "press",
    });

    setEdgeRuntimeStateForTests(cloudState);
    const list = await reader.client
      .get(PANIC_ROUTES.cloudList(outlet))
      .set("Host", tenant.hostname);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).toContain(live.alert.id);
    expect(text).not.toContain(test.alert.id);
  });
});

// ===========================================================================
// EM-20 resolve is cloud only
// ===========================================================================

describe("EM-20 resolve is not available on the edge; in the cloud it needs facility.emergency.resolve", () => {
  it("EM-20 resolve and the manager list on the edge are 404 (cloud only), even with a receiver session", async () => {
    const outlet = await world("EM-20 edge");
    const button = await registerPanicButton(outlet);
    const rcv = await receiverFor(outlet, "EM20 Receiver");
    const { alert } = await raise(button);

    const viaCloudPath = await request(edgeApp)
      .post(PANIC_ROUTES.cloudResolve(outlet, alert.id))
      .set(originHeader)
      .set("Cookie", rcv.cookie)
      .send(resolveBody("selesai"));
    expect(viaCloudPath.status).toBe(404);
    expect(codeOf(viaCloudPath)).toBe("CLOUD_ONLY_ROUTE");

    const viaEdgePath = await request(edgeApp)
      .post(`/api/emergency/alerts/${encodeURIComponent(alert.id)}/resolve`)
      .set(originHeader)
      .set("Cookie", rcv.cookie)
      .send(resolveBody("selesai"));
    expect(viaEdgePath.status).toBe(404);

    const list = await request(edgeApp)
      .get(PANIC_ROUTES.cloudList(outlet))
      .set("Cookie", rcv.cookie);
    expect(list.status).toBe(404);
    expect(codeOf(list)).toBe("CLOUD_ONLY_ROUTE");
    expect((await alertById(alert.id)).resolved_at).toBeNull();
  });

  it("EM-20 cloud resolve: 401 anonymous, 403 without facility.emergency.resolve, 200 with it (sets acknowledge too)", async () => {
    const outlet = await world("EM-20 cloud");
    const button = await registerPanicButton(outlet);
    const { alert } = await raise(button);
    const respondOnly = await newStaff("EM20 Respond", outlet, {
      permissions: [PANIC_PERMISSION_RESPOND],
      onDuty: false,
    });
    const manager = await newStaff("EM20 Manager", outlet, {
      permissions: [PANIC_PERMISSION_RESOLVE],
      onDuty: false,
    });
    setEdgeRuntimeStateForTests(cloudState);
    const path = PANIC_ROUTES.cloudResolve(outlet, alert.id);

    const anonymous = await request(cloudApp)
      .post(path)
      .set(cloudHeaders())
      .send(resolveBody("selesai"));
    expect(anonymous.status).toBe(401);
    const denied = await respondOnly.client
      .post(path)
      .set(cloudHeaders())
      .send(resolveBody("selesai"));
    expect(denied.status).toBe(403);
    expect((await alertById(alert.id)).resolved_at).toBeNull();

    const tooLong = await manager.client
      .post(path)
      .set(cloudHeaders())
      .send(resolveBody("x".repeat(501)));
    expect([400, 422]).toContain(tooLong.status);
    const missing = await manager.client
      .post(PANIC_ROUTES.cloudResolve(outlet, randomUUID()))
      .set(cloudHeaders())
      .send(resolveBody("selesai"));
    expect(missing.status).toBe(404);

    const ok = await manager.client
      .post(path)
      .set(cloudHeaders())
      .send(resolveBody("Tamu aman, kamar dicek"));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const stored = await alertById(alert.id);
    expect(stored.resolved_by).toBe(manager.userId);
    expect(stored.resolved_at).not.toBeNull();
    expect(stored.resolution_note).toBe("Tamu aman, kamar dicek");
    // Resolve also acknowledges when nobody did (D-07).
    expect(stored.acknowledged_at).not.toBeNull();
  });

  it("EM-20 Q95 only outlet manager and general manager close an incident: facility attendant and supervisor get 403, both managers 200", async () => {
    const outlet = await world("EM-20 Q95");
    const button = await registerPanicButton(outlet);
    const cases = [
      ...["facility_attendant", "supervisor"].map((key) => ({
        key,
        ok: false,
      })),
      ...PANIC_RESOLVER_ROLES.map((key) => ({ key, ok: true })),
    ];
    for (const { key, ok } of cases) {
      const alertRow = (await raise(button, newEventId())).alert;
      // A resolved alert stays resolved and an acknowledged one is not folded:
      // acknowledge first so every case gets its own alert.
      const staff = await newStaff(`Q95 ${key}`, outlet, {
        template: key as RoleTemplateKey,
        onDuty: false,
      });
      await verifySessionMfa(staff.email);
      setEdgeRuntimeStateForTests(cloudState);
      const res = await staff.client
        .post(PANIC_ROUTES.cloudResolve(outlet, alertRow.id))
        .set(cloudHeaders())
        .send(resolveBody(`ditutup oleh ${key}`));
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(
        ok ? 200 : 403,
      );
      expect((await alertById(alertRow.id)).resolved_by).toBe(
        ok ? staff.userId : null,
      );
      actAsEdge(outlet);
      // Close the alert so the next press is a new alert, not a fold.
      await asTenantOwner((c) =>
        c.query(
          "UPDATE panic_alerts SET acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, $3) WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, alertRow.id, staff.userId],
        ),
      );
    }
  }, 30_000);
});
