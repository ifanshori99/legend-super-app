// Test fixture (E2, brief 1269): a live `edge_staff_pin` session of `userId` on
// `device`, the only session an edge process accepts, as an agent that sends its
// cookie and the device's token on every request. The login route itself is
// covered by edge-staff-pin-session.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import type { Pool } from "pg";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { setCustomerSessionCookie } from "../lib/identity-session.ts";
import { agent } from "./helpers.ts";

export async function edgeStaffAgent(
  owner: Pool,
  app: Express,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly device: { readonly id: string; readonly token: string };
  },
): Promise<ReturnType<typeof agent>> {
  const issued = {
    id: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  await owner.query(
    `INSERT INTO session
       (id, token, expires_at, created_at, updated_at, last_seen_at, user_id,
        tenant_id, auth_method, edge_device_id)
     VALUES ($1, $2, $3, now(), now(), now(), $4, $5, 'edge_staff_pin', $6)`,
    [
      issued.id,
      issued.token,
      issued.expiresAt,
      input.userId,
      input.tenantId,
      input.device.id,
    ],
  );
  let cookie = "";
  setCustomerSessionCookie(
    {
      cookie: (name: string, value: string) => {
        cookie = `${name}=${encodeURIComponent(value)}`;
      },
    } as unknown as Response,
    issued,
  );
  const client = agent(app);
  client.set("Cookie", cookie);
  client.set(DEVICE_TOKEN_HEADER, input.device.token);
  return client;
}
