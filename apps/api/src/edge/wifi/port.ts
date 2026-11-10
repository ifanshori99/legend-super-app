// Port between the Wi-Fi sessions services (kmd3, served on the edge) and the
// edge Wi-Fi agent (bead legend-hsk, plan docs/briefs/sub-ws09-wifi-plan.md
// section 5). The services call `wifiEnforcement()` in process; the runtime
// installs the agent on a primary edge node once its provider is ready.
//
// Fail closed: with nothing installed (cloud, a standby node, no controller
// adapter yet, or the outlet lock held by another process) every call answers
// 503 WIFI_AGENT_NOT_READY. A grant is never guessed or skipped.
import type { WifiAgent } from "../../services/edge-wifi-agent.service.ts";
import { HttpError } from "../../lib/http-error.ts";

/** What the sessions services may call. */
export type WifiEnforcement = Pick<WifiAgent, "applySession" | "endSession">;

function notReady(): never {
  throw new HttpError(
    503,
    "WIFI_AGENT_NOT_READY",
    "Agen Wi-Fi belum siap di server lokal ini.",
  );
}

const notReadyEnforcement: WifiEnforcement = {
  applySession: async () => notReady(),
  endSession: async () => notReady(),
};

let enforcement: WifiEnforcement = notReadyEnforcement;
let agent: WifiAgent | null = null;

/** Install the enforcement the sessions services call; `null` fails closed. */
export function installWifiEnforcement(impl: WifiEnforcement | null): void {
  enforcement = impl ?? notReadyEnforcement;
}

/**
 * True while a real agent (or a test double) is installed: false on the cloud,
 * on a standby, and while another process holds the outlet's agent lock.
 */
export function isWifiEnforcementInstalled(): boolean {
  return enforcement !== notReadyEnforcement;
}

export function wifiEnforcement(): WifiEnforcement {
  return enforcement;
}

/**
 * Install the whole agent: the enforcement above plus the staff reads served
 * by `/api/edge/wifi` (live grants, walled garden). `null` fails closed.
 */
export function installWifiAgent(next: WifiAgent | null): void {
  agent = next;
  installWifiEnforcement(next);
}

/** The installed agent; 503 WIFI_AGENT_NOT_READY when there is none. */
export function wifiAgent(): WifiAgent {
  return agent ?? notReady();
}
