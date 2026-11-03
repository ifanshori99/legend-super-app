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
import { z } from "zod";
import { deploymentEnvShape } from "@starter/shared/env";
import { parseEdgeCredential } from "./credential.ts";
import { LINK_PATH } from "./protocol.ts";

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
    },
  };
}
