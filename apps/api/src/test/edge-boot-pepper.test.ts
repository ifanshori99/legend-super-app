// Edge boot refuses the root staff pin pepper (bead legend-ideif; PRD v1.7 §3
// F5 Server Lokal, TEN-02). A stolen edge box must never yield the root, so
// startEdgeRuntime stops with an EdgeBootError when the edge's environment
// source holds STAFF_PIN_PEPPER, naming the key and never its value. The guard
// runs before any database or cloud access, so this test needs neither.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { EdgeBootError, startEdgeRuntime } from "../edge/runtime.ts";

const ROOT_VALUE = `root-pepper-${randomUUID()}-must-not-be-echoed`;

const edgeSource = (extra: Record<string, string> = {}) => ({
  EDGE_MODE: "true",
  EDGE_CLOUD_URL: "wss://cloud.boot-pepper.test/api/edge-link",
  EDGE_NODE_CREDENTIAL: mintEdgeCredential({
    tenantId: randomUUID(),
    outletId: randomUUID(),
    edgeNodeId: randomUUID(),
  }).token,
  EDGE_NODE_ROLE: "primary",
  ...extra,
});

describe("legend-ideif the edge refuses to boot with the root pepper", () => {
  it("rejects with an EdgeBootError that names the key, never the value", async () => {
    const error = await startEdgeRuntime(
      edgeSource({ STAFF_PIN_PEPPER: ROOT_VALUE }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EdgeBootError);
    const message = String((error as Error).message);
    expect(message).toContain("STAFF_PIN_PEPPER");
    expect(message).not.toContain(ROOT_VALUE);
  });

  it("a cloud process (EDGE_MODE off) with the root pepper still starts", async () => {
    const handle = await startEdgeRuntime({
      EDGE_MODE: "false",
      STAFF_PIN_PEPPER: ROOT_VALUE,
    });
    await handle.stop();
  });
});
