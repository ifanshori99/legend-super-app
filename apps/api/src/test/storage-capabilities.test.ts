// M6 (bead legend-egrrp, brief docs/briefs/sub-storage-m6.md): GET
// /api/storage/capabilities tells the web whether document (PDF) uploads can be
// vetted. Written fail-first from the brief, not from the implementation.
//
// Contract: requireAuth (no tenant permission); answer { data: {
// documentsAccepted: boolean } }; documentsAccepted is
// `runtime !== null && scanner.acceptsDocuments !== false`; it does not call
// the scanner (it is not a health check).
//
// Assumptions:
// - The envelope is { data: { documentsAccepted } } like the other storage
//   endpoints (dataResponseSchema); a missing session answers 401.
// - "Noop prod" is a NoopMalwareScanner with acceptsDocuments:false, "scanner
//   accepts" is acceptsDocuments:true.
import { describe, expect, it, vi } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, signUp } from "./helpers.ts";

const PATH = "/api/storage/capabilities";

function appWith(scanner: MalwareScanner | null) {
  const runtime: StorageRuntime | null = scanner
    ? {
        storage: new FakeObjectStorage(),
        scanner,
        fileSigner: async () => "https://signed.example.test/x",
        hrisDocumentSigner: async () => null,
      }
    : null;
  return createApp({ storageRuntime: runtime });
}

async function capabilities(app: ReturnType<typeof createApp>) {
  const client = agent(app);
  await signUp(client, "Storage Capabilities");
  return client.get(PATH);
}

describe("legend-egrrp GET /api/storage/capabilities", () => {
  it("[egrrp-cap-401] without a session it answers 401", async () => {
    const res = await agent(
      appWith(new NoopMalwareScanner({ acceptsDocuments: true })),
    ).get(PATH);
    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });

  it("[egrrp-cap-noop-prod] a scanner that does not accept documents (Noop in production) -> documentsAccepted false", async () => {
    const res = await capabilities(
      appWith(new NoopMalwareScanner({ acceptsDocuments: false })),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ data: { documentsAccepted: false } });
  });

  it("[egrrp-cap-accepts] a scanner that accepts documents -> documentsAccepted true, any signed-in user", async () => {
    const res = await capabilities(
      appWith(new NoopMalwareScanner({ acceptsDocuments: true })),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ data: { documentsAccepted: true } });
  });

  it("[egrrp-cap-no-runtime] without a storage runtime -> documentsAccepted false (200, not an error)", async () => {
    const res = await capabilities(appWith(null));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ data: { documentsAccepted: false } });
  });

  it("[egrrp-cap-no-scan] answering does not call the scanner (it is not a health probe)", async () => {
    const scan = vi.fn(async () => {});
    const res = await capabilities(appWith({ scan }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.documentsAccepted).toBe(true);
    expect(scan).not.toHaveBeenCalled();
  });
});
