// Edge-side sealed storage of the derived staff pin peppers (bead legend-ideif;
// PRD v1.7 §3 F5 Server Lokal, EDG-02, TEN-02). Seal: AES-256-GCM bound to the
// tenant and key version; the key comes from the edge credential secret. Cloud
// and edge share one test database, so the "edge node" is a registered node on
// a private outlet (as edge-staff-pin-pull.test.ts does).
import { randomBytes, randomUUID } from "node:crypto";
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
  deriveEdgePepperSealKey,
  loadEdgePeppers,
  openEdgePepper,
  saveEdgePeppers,
  sealEdgePepper,
} from "../edge/staff-pin-pepper-store.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = randomUUID();
const key = deriveEdgePepperSealKey("secret-of-the-node-credential");
const otherKey = deriveEdgePepperSealKey("a-rotated-node-credential-secret");
const binding = { tenantId, version: 1 };

describe("legend-ideif sealing a pepper", () => {
  it("round trips, and two seals of one pepper differ (random IV)", () => {
    const pepper = randomBytes(32);
    const sealed = sealEdgePepper(key, binding, pepper);
    expect(openEdgePepper(key, binding, sealed)?.equals(pepper)).toBe(true);
    expect(sealEdgePepper(key, binding, pepper)).not.toBe(sealed);
    expect(Buffer.from(sealed, "base64").includes(pepper)).toBe(false);
  });

  it("the seal key is 32 bytes, stable, and differs per credential secret", () => {
    expect(key).toHaveLength(32);
    expect(
      deriveEdgePepperSealKey("secret-of-the-node-credential").equals(key),
    ).toBe(true);
    expect(otherKey.equals(key)).toBe(false);
  });

  it("opens to null under the wrong key, another tenant or another version", () => {
    const sealed = sealEdgePepper(key, binding, randomBytes(32));
    expect(openEdgePepper(otherKey, binding, sealed)).toBeNull();
    expect(
      openEdgePepper(key, { ...binding, tenantId: randomUUID() }, sealed),
    ).toBeNull();
    expect(openEdgePepper(key, { ...binding, version: 2 }, sealed)).toBeNull();
  });

  it("opens to null, without throwing, for garbage, short or tampered input", () => {
    const sealed = sealEdgePepper(key, binding, randomBytes(32));
    const raw = Buffer.from(sealed, "base64");
    const last = raw.length - 1;
    raw.writeUInt8(raw.readUInt8(last) ^ 0xff, last);
    const bad = [
      "",
      "AAAA",
      "not base64 !!",
      "x".repeat(10_000),
      raw.toString("base64"),
    ];
    for (const value of bad) {
      expect(() => openEdgePepper(key, binding, value)).not.toThrow();
      expect(openEdgePepper(key, binding, value)).toBeNull();
    }
  });
});

describe("legend-ideif the sealed peppers in the edge database", () => {
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 4,
  });
  const tenant: TenantContext = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  const scope = {
    kind: "outlets" as const,
    outletIds: [outletIdSchema.parse(outletId)],
  };
  const context: ScopedTenantContext = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "device" }),
    scope,
  );
  let edgeNodeId = "";

  const rows = async () =>
    (
      await owner.query<{ version: number; ciphertext: string }>(
        "SELECT version, ciphertext FROM edge_staff_pin_peppers WHERE edge_node_id = $1 ORDER BY version",
        [edgeNodeId],
      )
    ).rows;

  beforeAll(async () => {
    setAuditWriter({ record: async () => {} });
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji pepper edge', address, timezone, opening_hours, status
         FROM outlets WHERE id = $3`,
      [
        outletId,
        `PP${outletId.slice(0, 8)}`.toUpperCase(),
        cafeLegendAccessFixtures.outletIds.bandung,
      ],
    );
    const registered = await registerEdgeNode(
      establishScopedTenantContext(tenant, scope),
      randomUUID(),
      { outletId, role: "standby", label: "uji pepper edge" },
    );
    edgeNodeId = registered.edgeNode.id;
  });

  afterAll(async () => {
    setAuditWriter(null);
    try {
      for (const sql of [
        "DELETE FROM edge_staff_pin_peppers WHERE outlet_id = $1",
        "DELETE FROM edge_nodes WHERE outlet_id = $1",
        "DELETE FROM outlets WHERE id = $1",
      ])
        await owner.query(sql, [outletId]);
    } catch {
      // Best effort: leftovers sit on a private outlet no other file reads.
    }
    await owner.end();
  });

  it("save then load returns the same bytes, and the stored text hides the pepper", async () => {
    const v1 = randomBytes(32);
    const v2 = randomBytes(32);
    await saveEdgePeppers(context, edgeNodeId, key, [
      { version: 1, pepper: v1 },
      { version: 2, pepper: v2 },
    ]);
    const loaded = await loadEdgePeppers(context, edgeNodeId, key);
    expect([...loaded.keys()].sort()).toEqual([1, 2]);
    expect(loaded.get(1)?.equals(v1)).toBe(true);
    expect(loaded.get(2)?.equals(v2)).toBe(true);
    for (const row of await rows()) {
      const pepper = row.version === 1 ? v1 : v2;
      expect(row.ciphertext).not.toContain(pepper.toString("base64"));
      expect(Buffer.from(row.ciphertext, "base64").includes(pepper)).toBe(
        false,
      );
    }
  });

  it("a second save of a version replaces it (upsert) and keeps the others", async () => {
    const replaced = randomBytes(32);
    await saveEdgePeppers(context, edgeNodeId, key, [
      { version: 1, pepper: replaced },
    ]);
    const loaded = await loadEdgePeppers(context, edgeNodeId, key);
    expect(loaded.get(1)?.equals(replaced)).toBe(true);
    expect(loaded.has(2)).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  it("an empty save changes nothing", async () => {
    await saveEdgePeppers(context, edgeNodeId, key, []);
    expect(await rows()).toHaveLength(2);
  });

  it("a rotated credential (another seal key) loads an empty map", async () => {
    expect((await loadEdgePeppers(context, edgeNodeId, otherKey)).size).toBe(0);
  });

  it("a row moved to another version fails to open and the others still load", async () => {
    const [first, second] = await rows();
    await owner.query(
      "UPDATE edge_staff_pin_peppers SET ciphertext = $1 WHERE edge_node_id = $2 AND version = 2",
      [first!.ciphertext, edgeNodeId],
    );
    const loaded = await loadEdgePeppers(context, edgeNodeId, key);
    expect([...loaded.keys()]).toEqual([1]);
    await owner.query(
      "UPDATE edge_staff_pin_peppers SET ciphertext = $1 WHERE edge_node_id = $2 AND version = 2",
      [second!.ciphertext, edgeNodeId],
    );
  });

  it("saving for an unknown node is refused, without the pepper in the message", async () => {
    const pepper = randomBytes(32);
    const error = await saveEdgePeppers(context, randomUUID(), key, [
      { version: 1, pepper },
    ]).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(
      pepper.toString("base64"),
    );
  });
});
