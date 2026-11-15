import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  storageSourceKindPurpose,
  uploadStorageMetadataSchema,
} from "@starter/shared/storage";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { storageSourcePermissionMap } from "../services/core-storage-access.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});
const kinds = [
  {
    kind: "cleaning_task",
    upload: "facility.booth.operate",
    review: "facility.config.manage",
    peerReads: false,
  },
  {
    kind: "maintenance_ticket",
    upload: "ops.equipment.maintain",
    review: "facility.config.manage",
    peerReads: true,
  },
  {
    kind: "checklist_evidence",
    upload: "ops.checklist.complete",
    review: "ops.checklist.manage",
    peerReads: false,
  },
] as const;

const crew = agent(app);
const manager = agent(app);
const nobody = agent(app);
const crewPeer = agent(app);
const crewOtherOutlet = agent(app);
const managerOtherOutlet = agent(app);
const roleIds: string[] = [];
let image: Buffer;

const grant = async (
  who: ReturnType<typeof agent>,
  name: string,
  codes: readonly string[],
  outletId = outletA,
) => {
  const userId = (await who.get("/api/auth/get-session")).body.user.id;
  const roleId = randomUUID();
  roleIds.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types) VALUES ($1, $2, $3, $4, '["outlet"]')`,
    [roleId, tenantId, name, JSON.stringify(codes)],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by) VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleId, outletId],
  );
};

beforeAll(async () => {
  await signUp(crew, "Facility Media Crew");
  await signUp(manager, "Facility Media Manager");
  await signUp(nobody, "Facility Media Nobody");
  await grant(
    crew,
    "Facility Media Crew",
    kinds.map((entry) => entry.upload),
  );
  // Review codes only: reads, but cannot upload cleaning or checklist media.
  await grant(manager, "Facility Media Manager", [
    "facility.config.manage",
    "ops.checklist.manage",
  ]);
  await signUp(crewPeer, "Facility Media Crew Peer");
  await signUp(crewOtherOutlet, "Facility Media Crew Outlet B");
  await signUp(managerOtherOutlet, "Facility Media Manager Outlet B");
  await grant(
    crewPeer,
    "Facility Media Crew Peer",
    kinds.map((entry) => entry.upload),
  );
  await grant(
    crewOtherOutlet,
    "Facility Media Crew Outlet B",
    kinds.map((entry) => entry.upload),
    outletB,
  );
  await grant(
    managerOtherOutlet,
    "Facility Media Manager Outlet B",
    [
      "facility.config.manage",
      "ops.checklist.manage",
      "ops.equipment.maintain",
    ],
    outletB,
  );
  image = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await owner.query(
    "DELETE FROM role_assignments WHERE role_id = ANY($1::uuid[])",
    [roleIds],
  );
  await owner.end();
});

const upload = (
  who: ReturnType<typeof agent>,
  kind: string,
  outletId = outletA,
) =>
  who
    .post("/api/storage/uploads")
    .set(originHeader)
    .field("purpose", "receipt")
    .field("sourceKind", kind)
    .field("outletId", outletId)
    .attach("file", image, "evidence.png");
const signed = (who: ReturnType<typeof agent>, id: string) =>
  who
    .post(`/api/storage/objects/${id}/signed-url`)
    .set(originHeader)
    .send({ variant: "original" });

describe("facility evidence source kinds", () => {
  it("classifies each kind as private receipt evidence with its feature permission", () => {
    for (const { kind, upload: uploadCode, review } of kinds) {
      expect(Reflect.get(storageSourceKindPurpose, kind)).toBe("receipt");
      expect(
        uploadStorageMetadataSchema.safeParse({
          purpose: "receipt",
          sourceKind: kind,
          outletId: outletA,
        }).success,
      ).toBe(true);
      const rule = Reflect.get(storageSourcePermissionMap, kind);
      expect(rule.upload).toEqual([uploadCode]);
      expect(rule.read).toContain(review);
    }
  });

  it.each(kinds)(
    "lets crew upload $kind and read it back, and lets a reviewer read it",
    async ({ kind, peerReads }) => {
      const created = await upload(crew, kind);
      expect(created.status).toBe(201);
      expect(created.body.data.publicUrl).toBeNull();
      const row = await owner.query(
        "SELECT source_kind, purpose FROM core_storage_objects WHERE id = $1",
        [created.body.data.id],
      );
      expect(row.rows[0]).toMatchObject({
        source_kind: kind,
        purpose: "receipt",
      });
      expect((await signed(crew, created.body.data.id)).status).toBe(200);
      expect((await signed(manager, created.body.data.id)).status).toBe(200);
      expect((await signed(nobody, created.body.data.id)).status).toBe(403);
      // Same code, same outlet: only the maintenance team reads a colleague's
      // photo; cleaning and checklist evidence (signatures) stays with the
      // owner and the manager.
      expect((await signed(crewPeer, created.body.data.id)).status).toBe(
        peerReads ? 200 : 403,
      );
      // Same code, other outlet: scope blocks the read.
      expect((await signed(crewOtherOutlet, created.body.data.id)).status).toBe(
        403,
      );
      // Review code held only at the other outlet: scope blocks the read.
      expect(
        (await signed(managerOtherOutlet, created.body.data.id)).status,
      ).toBe(403);
    },
  );

  it.each(kinds)(
    "denies uploading $kind without the feature permission or outside the outlet",
    async ({ kind }) => {
      expect((await upload(nobody, kind)).status).toBe(403);
      expect((await upload(crew, kind, outletB)).status).toBe(403);
    },
  );

  it("does not let a review-only code upload cleaning or checklist media", async () => {
    expect((await upload(manager, "cleaning_task")).status).toBe(403);
    expect((await upload(manager, "checklist_evidence")).status).toBe(403);
  });
});
