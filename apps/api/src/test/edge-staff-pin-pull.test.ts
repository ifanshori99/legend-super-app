// Edge staff pin pull (bead legend-yvhw8, tier K; PRD v1.7 §3 F6, EDG-02). The
// loop that follows the cloud export page by page, applies each page on the
// node's own context and stores the watermark only once every page landed.
// Cloud and edge share one test database, so the "edge" is played by deleting
// the cloud row first and the "cloud" is `listStaffPinRecordsSince` (or a
// captured page, where the edge must hold an older generation than the row in
// this one database).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  outletIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createStaffPinRecordsFetcher,
  EdgeCloudHttpError,
} from "../edge/cloud-http.ts";
import { createStaffPinPull, pullStaffPins } from "../edge/staff-pin-pull.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  loadStaffPinCheckpoint,
  saveStaffPinCheckpoint,
} from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  applyStaffPinRecords,
  listStaffPinRecordsSince,
  type StaffPinSyncPage,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
// Own outlet (cloned in beforeAll): one outlet allows one active node per
// role, and other files register theirs on the fixture outlets.
const outletId = randomUUID();
const actor = randomUUID();
const PIN_A = "582914";
const PIN_B = "730418";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const scope = {
  kind: "outlets" as const,
  outletIds: [outletIdSchema.parse(outletId)],
};
const edgeContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "device" }),
  scope,
);
let edgeNodeId = "";

async function newStaff(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf tarik PIN', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  const {
    rows: [role],
  } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
    [tenantId, id, role!.id, outletId],
  );
  return id;
}

const setCloudPin = (userId: string, pin: string) =>
  setStaffPin(tenant, userId, { outletId, userId }, { pin });

async function pinHashOf(userId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ pin_hash: string }>(
    "SELECT pin_hash FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenantId, outletId, userId],
  );
  return rows[0]?.pin_hash;
}

async function deletePin(userId: string) {
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
}

/** The live export page, as the cloud route answers it. */
const livePage = (
  cursor: string | null,
  limit = 100,
): Promise<StaffPinSyncPage> =>
  listStaffPinRecordsSince(
    { tenantId, outletId: outletIdSchema.parse(outletId), edgeNodeId },
    { since: cursor ?? undefined, limit },
  );

/**
 * Waits until the export carries the user's record (an open transaction of
 * another test file holds the commit horizon back for a moment) and returns
 * the pages, the records and the final watermark.
 */
async function awaitExport(
  userId: string,
  since: string | null = null,
  limit = 100,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pages: StaffPinSyncPage[] = [];
    let cursor = since;
    let watermark: string | null = since;
    for (;;) {
      const page = await livePage(cursor, limit);
      pages.push(page);
      watermark = page.meta.watermark ?? watermark;
      if (page.meta.nextCursor === null) break;
      cursor = page.meta.nextCursor;
    }
    const records = pages.flatMap((page) => page.data);
    if (records.some((row) => row.userId === userId))
      return { pages, records, watermark, since };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The pin record never reached the export");
}

/**
 * The cloud answering from captured pages (the live export cannot serve
 * them once the test deleted the shared row to play the edge). An unknown
 * cursor is refused with HTTP 400, as the cloud does.
 */
function serve(captured: Awaited<ReturnType<typeof awaitExport>>) {
  const byCursor = new Map<string | null, StaffPinSyncPage>();
  let cursor: string | null = captured.since;
  for (const page of captured.pages) {
    byCursor.set(cursor, page);
    cursor = page.meta.nextCursor;
  }
  const asked: Array<string | null> = [];
  const fetchPage = async (next: string | null) => {
    asked.push(next);
    const page = byCursor.get(next);
    if (!page) throw new EdgeCloudHttpError("HTTP_400");
    return page;
  };
  return { fetchPage, asked };
}

/** One run as the runtime wires it: load, pull, save after the pull. */
async function runPull(
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<unknown>,
  onRestart?: () => void,
) {
  const pull = createStaffPinPull({
    context: edgeContext,
    fetchPage,
    onRestart,
  });
  const stored = await loadStaffPinCheckpoint(edgeContext, edgeNodeId);
  const result = await pull(stored.watermark, new AbortController().signal);
  await saveStaffPinCheckpoint(edgeContext, edgeNodeId, {
    watermark: result.watermark,
    succeededAt: new Date(),
  });
  return result;
}

beforeAll(async () => {
  setAuditWriter({ record: async () => {} });
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji tarik PIN', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [
      outletId,
      `SP${outletId.slice(0, 8)}`.toUpperCase(),
      cafeLegendAccessFixtures.outletIds.bandung,
    ],
  );
  const registered = await registerEdgeNode(
    establishScopedTenantContext(tenant, scope),
    actor,
    { outletId, role: "standby", label: "uji tarik PIN" },
  );
  edgeNodeId = registered.edgeNode.id;
});

afterAll(async () => {
  setAuditWriter(null);
  try {
    for (const [text, params] of [
      [
        `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->'payload'->>'userId' = ANY($2::text[])`,
        [tenantId, createdUserIds],
      ],
      ["DELETE FROM staff_pins WHERE outlet_id = $1", [outletId]],
      ["DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1", [outletId]],
      ["DELETE FROM role_assignments WHERE scope_id = $1", [outletId]],
      ["DELETE FROM edge_nodes WHERE outlet_id = $1", [outletId]],
      ["DELETE FROM outlets WHERE id = $1", [outletId]],
      [`DELETE FROM "user" WHERE id = ANY($1::text[])`, [createdUserIds]],
    ] as const)
      await owner.query(text, [...params]);
  } catch {
    // Best effort: leftovers sit on a private outlet no other file reads.
  }
  await owner.end();
});

describe("legend-yvhw8 the edge pulls staff pins from the cloud", () => {
  it("a PIN reset on the cloud reaches the edge row, the cursor is saved, the next pull is a no-op", async () => {
    const userId = await newStaff();
    await setCloudPin(userId, PIN_A);
    const first = await awaitExport(userId);
    const recordA = first.records.find((row) => row.userId === userId)!;

    // First pull from nothing: the edge copy is created from the export.
    await deletePin(userId);
    const pulledA = await runPull(serve(first).fetchPage);
    expect(await pinHashOf(userId)).toBe(recordA.pinHash);
    expect(pulledA.watermark).toBe(first.watermark);
    expect(
      (await loadStaffPinCheckpoint(edgeContext, edgeNodeId)).watermark,
    ).toBe(first.watermark);
    // The cloud resets the PIN; capture what its export sends past the saved
    // cursor, then put the edge back on the old generation (one database
    // cannot hold both generations at once).
    await setCloudPin(userId, PIN_B);
    const reset = await awaitExport(userId, first.watermark);
    const recordB = reset.records.find((row) => row.userId === userId)!;
    expect(recordB.pinHash).not.toBe(recordA.pinHash);
    await deletePin(userId);
    await applyStaffPinRecords(edgeContext, [recordA]);
    expect(await pinHashOf(userId)).toBe(recordA.pinHash);

    const served = serve(reset);
    const pulledB = await runPull(served.fetchPage);
    // The pull resumed from the stored cursor and the reset replaced the pin.
    expect(served.asked).toEqual([first.watermark]);
    expect(await pinHashOf(userId)).toBe(recordB.pinHash);
    expect(pulledB.watermark).toBe(reset.watermark);
    expect(
      (await loadStaffPinCheckpoint(edgeContext, edgeNodeId)).watermark,
    ).toBe(reset.watermark);

    // Nothing new on the cloud: an empty page echoing the cursor, no write.
    const before = await pinHashOf(userId);
    const asked: Array<string | null> = [];
    const idle = await runPull(async (cursor) => {
      asked.push(cursor);
      return {
        data: [],
        meta: { limit: 100, nextCursor: null, watermark: cursor },
      } satisfies StaffPinSyncPage;
    });
    expect(asked).toEqual([reset.watermark]);
    expect(idle.watermark).toBe(reset.watermark);
    expect(await pinHashOf(userId)).toBe(before);
  });

  it("follows nextCursor across pages and saves the watermark only after every page was applied", async () => {
    const one = await newStaff();
    const two = await newStaff();
    await setCloudPin(one, PIN_A);
    await setCloudPin(two, PIN_B);
    await awaitExport(one);
    const exported = await awaitExport(two, null, 1);
    await owner.query(
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1",
      [outletId],
    );
    const hashes = new Map<string, string>(
      exported.records.map((row) => [row.userId, row.pinHash]),
    );
    await deletePin(one);
    await deletePin(two);
    expect(exported.pages.length).toBeGreaterThanOrEqual(2);

    // Page two fails: page one is applied (its own transaction) but the
    // checkpoint must stay where it was.
    const { fetchPage } = serve(exported);
    let calls = 0;
    await expect(
      runPull(async (cursor) => {
        calls += 1;
        if (calls === 2) throw new EdgeCloudHttpError("HTTP_503");
        return fetchPage(cursor);
      }),
    ).rejects.toThrow(/HTTP_503/);
    expect(
      (await loadStaffPinCheckpoint(edgeContext, edgeNodeId)).watermark,
    ).toBeNull();

    // The retry runs from the same (null) cursor and walks every page.
    const retry = serve(exported);
    const result = await runPull(retry.fetchPage);
    expect(retry.asked.length).toBe(exported.pages.length);
    expect(await pinHashOf(one)).toBe(hashes.get(one));
    expect(await pinHashOf(two)).toBe(hashes.get(two));
    expect(
      (await loadStaffPinCheckpoint(edgeContext, edgeNodeId)).watermark,
    ).toBe(result.watermark);
    expect(result.watermark).toBe(exported.watermark);
  });

  it("a refused stored cursor restarts once from the beginning; a refusal on a later page does not", async () => {
    const userId = await newStaff();
    await setCloudPin(userId, PIN_A);
    const exported = await awaitExport(userId);
    await deletePin(userId);
    await saveStaffPinCheckpoint(edgeContext, edgeNodeId, {
      watermark: "not-a-cursor",
      succeededAt: new Date(),
    });

    const { fetchPage, asked } = serve(exported);
    let restarts = 0;
    const result = await runPull(fetchPage, () => (restarts += 1));
    expect(asked[0]).toBe("not-a-cursor");
    expect(asked[1]).toBeNull();
    expect(restarts).toBe(1);
    expect(await pinHashOf(userId)).toBe(
      exported.records.find((row) => row.userId === userId)!.pinHash,
    );
    expect(result.watermark).toBe(exported.watermark);
    expect(
      (await loadStaffPinCheckpoint(edgeContext, edgeNodeId)).watermark,
    ).toBe(result.watermark);

    // A 400 on page two is a bad page, not a cursor problem: no restart.
    await owner.query(
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1",
      [outletId],
    );
    const paged = await awaitExport(userId, null, 1);
    const second = serve(paged);
    let calls = 0;
    restarts = 0;
    await expect(
      runPull(
        async (cursor) => {
          calls += 1;
          if (calls === 2) throw new EdgeCloudHttpError("HTTP_400");
          return second.fetchPage(cursor);
        },
        () => (restarts += 1),
      ),
    ).rejects.toThrow(/HTTP_400/);
    expect(restarts).toBe(0);
  });

  it("legend-r11j7 the pull client asks the cloud for the attempt revision (revision=1) on every page", async () => {
    const urls: string[] = [];
    const fetchPage = createStaffPinRecordsFetcher({
      cloudUrl: "wss://cloud.example.test/edge",
      credential: "edge-credential",
      limit: 7,
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const signal = new AbortController().signal;
    await fetchPage(null, signal);
    await fetchPage("cursor-1", signal);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const query = new URL(url).searchParams;
      expect(query.get("revision")).toBe("1");
      expect(query.get("limit")).toBe("7");
    }
    expect(new URL(urls[1]!).searchParams.get("since")).toBe("cursor-1");
  });

  it("an unreadable page fails without quoting its content", async () => {
    const secret = "S3CRET-HASH-MATERIAL";
    const error = await pullStaffPins({
      context: edgeContext,
      since: null,
      fetchPage: async () => ({ data: [{ pinHash: secret }], meta: {} }),
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(secret);
  });
});
