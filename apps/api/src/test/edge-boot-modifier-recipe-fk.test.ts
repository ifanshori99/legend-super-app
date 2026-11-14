// Edge boot refuses a database that still carries modifiers_recipe_fk (bead
// legend-cgduz; brief 800 part 4, second opinion pajak-fk-rotasi). On an edge
// database modifiers.recipe_id has no FK, because recipes sync later than
// modifiers. The FK shows up only when the migrator ran without EDGE_MODE
// (legend.edge_mode=on). startEdgeRuntime must then stop with an EdgeBootError
// whose message is clear: it names the constraint and tells the operator the
// migrations ran without EDGE_MODE. Written from the brief, not the
// implementation.
//
// Assumptions:
//   - The shared disposable test database is a cloud-style database, so
//     modifiers_recipe_fk exists there (migration 0374). The test asserts that
//     precondition, so it cannot pass vacuously.
//   - The message names "modifiers_recipe_fk" and "EDGE_MODE" (either spelling
//     of the setting, EDGE_MODE or edge_mode, is accepted).
//   - The guard never drops the constraint itself: it is still there after the
//     refusal, and the cloud process (EDGE_MODE off) still starts.
//   - Not covered here: the positive case (no FK, boot continues). It needs a
//     separate edge-migrated database; edge-bootstrap.test.ts covers a booting
//     edge.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { EdgeBootError, startEdgeRuntime } from "../edge/runtime.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const edgeSource = () => ({
  EDGE_MODE: "true",
  EDGE_CLOUD_URL: "wss://cloud.boot-modifier-fk.test/api/edge-link",
  EDGE_NODE_CREDENTIAL: mintEdgeCredential({
    tenantId: randomUUID(),
    outletId: randomUUID(),
    edgeNodeId: randomUUID(),
  }).token,
  EDGE_NODE_ROLE: "primary",
});

async function modifierRecipeFkCount(): Promise<number> {
  const result = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_constraint
      WHERE conname = 'modifiers_recipe_fk'
        AND conrelid = 'public.modifiers'::regclass`,
  );
  return Number(result.rows[0]!.n);
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("legend-cgduz edge boot refuses a database with modifiers_recipe_fk", () => {
  it("legend-cgduz startEdgeRuntime rejects with an EdgeBootError naming the constraint and the EDGE_MODE migration mistake", async () => {
    // Precondition: this database carries the FK.
    expect(await modifierRecipeFkCount()).toBe(1);

    const error = await startEdgeRuntime(edgeSource()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EdgeBootError);
    const message = String((error as Error).message);
    expect(message).toContain("modifiers_recipe_fk");
    expect(message).toMatch(/EDGE_MODE|edge_mode/);
    expect(message.length).toBeGreaterThan(40);
  });

  it("legend-cgduz the refusal leaves the constraint in place (never dropped automatically)", async () => {
    await startEdgeRuntime(edgeSource()).catch(() => undefined);
    expect(await modifierRecipeFkCount()).toBe(1);
  });

  it("legend-cgduz a cloud process (EDGE_MODE off) still starts with the FK present", async () => {
    expect(await modifierRecipeFkCount()).toBe(1);
    const handle = await startEdgeRuntime({ EDGE_MODE: "false" });
    await handle.stop();
  });
});
