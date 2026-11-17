// Credential carrier of the KDS station socket for browsers (legend-dsbqr).
// A browser cannot set headers on a WebSocket, so a shared-device tablet offers
// its device token and cashier token as extra Sec-WebSocket-Protocol entries
// (see KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX in @starter/shared/kitchen/
// realtime). Before the session is resolved, this moves them into the same
// `x-device-token` / `x-acting-staff` headers the 1017 path reads, so one
// validation covers both carriers and every wakeup / recheck re-resolves them
// from `request.headers`. Rules:
//
// - A real header wins over the subprotocol (never overridden).
// - Only the first entry of each prefix counts.
// - The credential entries are then removed from `sec-websocket-protocol`, so
//   the stored request no longer carries them there and the handshake can only
//   select KITCHEN_REALTIME_PROTOCOL (the server never echoes a credential).
// - Credentials offered without KITCHEN_REALTIME_PROTOCOL are refused (returns
//   false), so a socket never opens without a negotiated subprotocol.
// - Never the query string, never logged: this file has no logging.

import type { IncomingMessage } from "node:http";
import {
  KITCHEN_REALTIME_PROTOCOL,
  KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX,
  KITCHEN_REALTIME_STAFF_PROTOCOL_PREFIX,
} from "@starter/shared/kitchen";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_HEADER } from "@starter/shared/pos/acting-staff";

function hasHeader(request: IncomingMessage, name: string): boolean {
  const value = request.headers[name];
  return typeof value === "string" && value !== "";
}

/** False when the request must be denied (credentials without the KDS protocol). */
export function carryKdsCredentialsFromProtocols(
  request: IncomingMessage,
): boolean {
  const raw = request.headers["sec-websocket-protocol"];
  if (typeof raw !== "string") return true;
  const keep: string[] = [];
  let deviceToken: string | null = null;
  let staffToken: string | null = null;
  for (const entry of raw.split(",")) {
    const protocol = entry.trim();
    if (protocol === "") continue;
    if (protocol.startsWith(KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX)) {
      deviceToken ??= protocol.slice(
        KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX.length,
      );
    } else if (protocol.startsWith(KITCHEN_REALTIME_STAFF_PROTOCOL_PREFIX)) {
      staffToken ??= protocol.slice(
        KITCHEN_REALTIME_STAFF_PROTOCOL_PREFIX.length,
      );
    } else {
      keep.push(protocol);
    }
  }
  if (deviceToken !== null && deviceToken !== "") {
    if (!hasHeader(request, DEVICE_TOKEN_HEADER))
      request.headers[DEVICE_TOKEN_HEADER] = deviceToken;
  }
  if (staffToken !== null && staffToken !== "") {
    if (!hasHeader(request, ACTING_STAFF_HEADER))
      request.headers[ACTING_STAFF_HEADER] = staffToken;
  }
  if (deviceToken === null && staffToken === null) return true;
  if (!keep.includes(KITCHEN_REALTIME_PROTOCOL)) return false;
  request.headers["sec-websocket-protocol"] = keep.join(", ");
  return true;
}
