// Edge runtime settings (bead legend-2pi; PRD v1.7 §3 "Environment &
// Deployment": "ditambah image edge node"; §3 F5 "Server Lokal"). EDGE_MODE
// itself is parsed by @starter/shared/env (legend-lbc); these are the keys an
// edge node needs on top of it. Pure: reads the given source, never prints a
// value (the credential is a secret).
//
//   EDGE_CLOUD_URL        wss://<cloud api host>/api/edge-link (ws:// only in
//                         DEPLOYMENT_MODE=development)
//   EDGE_NODE_CREDENTIAL  edg1.<tenant>.<outlet>.<node>.<secret>, shown once
//                         when the node is registered on the cloud
//   EDGE_NODE_ROLE        primary | standby (default primary)
//   EDGE_NODE_VERSION     image version reported in heartbeats (default dev)
//   EDGE_DEVICE_SYNC_INTERVAL_SECONDS
//                         how often the edge pulls the device registry from
//                         the cloud (10..3600, default 60; legend-2lp.7)
//   EDGE_PEOPLE_SYNC_INTERVAL_SECONDS
//                         how often the edge pulls the people snapshot (users,
//                         roles, employees, shifts) from the cloud
//                         (10..3600, default 60)
//   EDGE_DEVICE_SYNC_STALE_SECONDS
//                         the replica counts as stale after this long without
//                         a successful pull (60..86400, default 900, at least
//                         twice the interval)
//   EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS
//                         hard limit (legend-2lgu): past this long without a
//                         successful pull the edge refuses NEW device
//                         sessions (enroll, token, first heartbeat); a device
//                         with a live heartbeat keeps running (3600..2592000,
//                         default 259200 = 72 h, at least twice
//                         EDGE_DEVICE_SYNC_STALE_SECONDS)
import { z } from "zod";
import { deploymentEnvShape } from "@starter/shared/env";
import { parseEdgeCredential } from "./credential.ts";
import { LINK_PATH } from "./protocol.ts";

/** legend-2lgu: default hard limit of the device-registry replica (72 h). */
export const DEFAULT_DEVICE_REGISTRY_MAX_STALE_SECONDS = 259_200;

const schema = z
  .object({
    DEPLOYMENT_MODE: deploymentEnvShape.DEPLOYMENT_MODE,
    EDGE_MODE: deploymentEnvShape.EDGE_MODE,
    EDGE_CLOUD_URL: z.string().optional(),
    EDGE_NODE_CREDENTIAL: z.string().optional(),
    EDGE_NODE_ROLE: z.enum(["primary", "standby"]).default("primary"),
    EDGE_NODE_VERSION: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\w.+-]+$/)
      .default("dev"),
    EDGE_DEVICE_SYNC_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(60),
    EDGE_PEOPLE_SYNC_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(60),
    EDGE_DEVICE_SYNC_STALE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(900),
    EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(2_592_000)
      .default(DEFAULT_DEVICE_REGISTRY_MAX_STALE_SECONDS),
  })
  .superRefine((values, ctx) => {
    if (!values.EDGE_MODE) return;
    let url: URL | null = null;
    try {
      url = values.EDGE_CLOUD_URL ? new URL(values.EDGE_CLOUD_URL) : null;
    } catch {
      url = null;
    }
    const secureRequired = values.DEPLOYMENT_MODE !== "development";
    if (
      !url ||
      !(
        url.protocol === "wss:" ||
        (!secureRequired && url.protocol === "ws:")
      ) ||
      url.pathname !== LINK_PATH ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      ctx.addIssue({
        code: "custom",
        path: ["EDGE_CLOUD_URL"],
        message: `Set EDGE_CLOUD_URL to wss://<cloud host>${LINK_PATH} (ws:// only in development).`,
      });
    if (
      values.EDGE_DEVICE_SYNC_STALE_SECONDS <
      2 * values.EDGE_DEVICE_SYNC_INTERVAL_SECONDS
    )
      ctx.addIssue({
        code: "custom",
        path: ["EDGE_DEVICE_SYNC_STALE_SECONDS"],
        message:
          "Set EDGE_DEVICE_SYNC_STALE_SECONDS to at least twice EDGE_DEVICE_SYNC_INTERVAL_SECONDS.",
      });
    if (
      values.EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS <
      2 * values.EDGE_DEVICE_SYNC_STALE_SECONDS
    )
      ctx.addIssue({
        code: "custom",
        path: ["EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS"],
        message:
          "Set EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS to at least twice EDGE_DEVICE_SYNC_STALE_SECONDS.",
      });
    if (!parseEdgeCredential(values.EDGE_NODE_CREDENTIAL))
      ctx.addIssue({
        code: "custom",
        path: ["EDGE_NODE_CREDENTIAL"],
        message:
          "Set EDGE_NODE_CREDENTIAL to the credential shown when this edge node was registered.",
      });
  });

export type EdgeRuntimeConfig =
  | { edgeMode: false }
  | {
      edgeMode: true;
      cloudUrl: string;
      credential: string;
      role: "primary" | "standby";
      version: string;
      deviceSyncIntervalMs: number;
      deviceSyncStaleAfterMs: number;
      /** legend-2lgu: hard limit; past it new device sessions are refused. */
      deviceRegistryMaxStaleMs: number;
      peopleSyncIntervalMs: number;
    };

export function parseEdgeRuntimeConfig(
  source: Record<string, string | undefined>,
): { ok: true; config: EdgeRuntimeConfig } | { ok: false; problems: string[] } {
  const parsed = schema.safeParse(source);
  if (!parsed.success)
    return {
      ok: false,
      // Field names and messages only, never the values.
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
      ),
    };
  const values = parsed.data;
  if (!values.EDGE_MODE) return { ok: true, config: { edgeMode: false } };
  return {
    ok: true,
    config: {
      edgeMode: true,
      cloudUrl: values.EDGE_CLOUD_URL as string,
      credential: values.EDGE_NODE_CREDENTIAL as string,
      role: values.EDGE_NODE_ROLE,
      version: values.EDGE_NODE_VERSION,
      deviceSyncIntervalMs: values.EDGE_DEVICE_SYNC_INTERVAL_SECONDS * 1000,
      deviceSyncStaleAfterMs: values.EDGE_DEVICE_SYNC_STALE_SECONDS * 1000,
      deviceRegistryMaxStaleMs:
        values.EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS * 1000,
      peopleSyncIntervalMs: values.EDGE_PEOPLE_SYNC_INTERVAL_SECONDS * 1000,
    },
  };
}
