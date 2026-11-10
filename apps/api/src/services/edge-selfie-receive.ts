// Cloud receives one sealed edge selfie (bead legend-0wvoz, C6; design
// docs/design/hris-edge-replication.md 5, 6.1, 6.3). Thin route
// (routes/edge-selfie-receive.routes.ts); every rule is here.
//
// `PUT /api/edge-sync/attendance-selfies/:objectId`, edge credential. The file
// is LSS1-sealed to a cloud key (services/edge-selfie-unseal.ts): the cloud
// opens it, re-encodes the image (EXIF and GPS dropped), stores original and
// thumbnail under `${objectId}/...`, and keeps one append-only receipt so a
// retry is a no-op. Linking to the attendance log is best effort and runs in
// either order (services/edge-selfie-link.ts); it never refuses an upload.
//
// Order: header hash (400), seal keys (503), one lock per object, receipt
// (discarded or same hash 200, other hash 409), object row without receipt
// (409 OBJECT_ID_TAKEN), unseal (422), scope (403), image, S3, rows, link.
// Never logs key material, plaintext or the sealed bytes.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObjectStorage } from "@starter/shared/adapters";
import { storagePurposePolicy } from "@starter/shared/storage";
import type * as schema from "../db/schema";
import { coreStorageObjects } from "../db/schema/core-storage";
import { edgeReceivedSelfies } from "../db/schema/edge-hris";
import { employees } from "../db/schema/hris";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { processImage, type MalwareScanner } from "./core-image";
import { linkEdgeSelfie } from "./edge-selfie-link";
import { edgeNodeContext } from "./edge-node.service";
import {
  loadSelfieSealKeys,
  SelfieUnsealError,
  unsealSelfie,
} from "./edge-selfie-unseal";
import type { VerifiedEdgeNode } from "./staff-pin-sync";

type Database = NodePgDatabase<typeof schema>;

export type ReceiveEdgeSelfieDeps = {
  database: Database;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  /** Test seam; production uses the database clock default. */
  now?: () => Date;
};

export type ReceiveEdgeSelfieInput = {
  objectId: string;
  body: Buffer;
  /** Value of `X-Legend-Sealed-Sha256`; undefined when the header is absent. */
  sealedSha256Header: string | undefined;
};

const SELFIE_PURPOSE = "selfie";

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function cannotDecrypt(): HttpError {
  return new HttpError(
    422,
    "SELFIE_UNSEAL_FAILED",
    "The sealed selfie could not be opened.",
  );
}

/** The configured seal keys; 503 when none (a malformed value counts as none). */
function readSealKeys(): ReturnType<typeof loadSelfieSealKeys> {
  const missing = () =>
    new HttpError(
      503,
      "SELFIE_SEAL_KEY_MISSING",
      "Selfie seal keys are not configured.",
    );
  let keys: ReturnType<typeof loadSelfieSealKeys>;
  try {
    keys = loadSelfieSealKeys();
  } catch (error) {
    if (error instanceof SelfieUnsealError) throw missing();
    throw error;
  }
  if (!keys || keys.size === 0) throw missing();
  return keys;
}

export async function receiveEdgeSelfie(
  deps: ReceiveEdgeSelfieDeps,
  node: VerifiedEdgeNode,
  input: ReceiveEdgeSelfieInput,
): Promise<{ status: 200 | 201 }> {
  const sealedHash = sha256(input.body);
  const claimed = input.sealedSha256Header?.trim().toLowerCase();
  if (claimed !== sealedHash.toString("hex"))
    throw new HttpError(
      400,
      "SEALED_HASH_MISMATCH",
      "The sealed hash header does not match the body.",
    );

  // Read per call: an operator may configure the keys without a restart.
  const keys = readSealKeys();

  const context = edgeNodeContext(node);
  const base = {
    tenantId: node.tenantId,
    outletId: node.outletId,
    reference: input.objectId,
    visibility: "private" as const,
  };
  const written: string[] = [];
  try {
    return await withTenant(deps.database, context, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-selfie:${node.tenantId}:${input.objectId}`}, 0))`,
      );

      const receipt = (
        await tx
          .select()
          .from(edgeReceivedSelfies)
          .where(
            and(
              eq(edgeReceivedSelfies.tenantId, node.tenantId),
              eq(edgeReceivedSelfies.objectId, input.objectId),
            ),
          )
          .limit(1)
      )[0];
      if (receipt) {
        // A purged selfie is discarded for good: answer 200 so the edge stops
        // retrying, write nothing.
        if (receipt.state === "discarded") return { status: 200 };
        if (sealedHash.equals(Buffer.from(receipt.sealedSha256)))
          return { status: 200 };
        throw new HttpError(
          409,
          "SELFIE_HASH_CONFLICT",
          "A different selfie already exists for this object id.",
        );
      }
      const existing = (
        await tx
          .select({ id: coreStorageObjects.id })
          .from(coreStorageObjects)
          .where(
            and(
              eq(coreStorageObjects.tenantId, node.tenantId),
              eq(coreStorageObjects.id, input.objectId),
            ),
          )
          .limit(1)
      )[0];
      // A phone upload (or another feature) already owns this id.
      if (existing)
        throw new HttpError(
          409,
          "OBJECT_ID_TAKEN",
          "This object id is already in use.",
        );

      let opened: ReturnType<typeof unsealSelfie>;
      try {
        opened = unsealSelfie(input.body, keys);
      } catch (error) {
        if (error instanceof SelfieUnsealError) throw cannotDecrypt();
        throw error;
      }
      const { header, meta, webp } = opened;
      if (
        !sameId(header.tenantId, node.tenantId) ||
        !sameId(header.objectId, input.objectId)
      )
        throw new HttpError(
          403,
          "FORBIDDEN",
          "The sealed selfie does not belong to this upload.",
        );
      if (!sameId(meta.outletId, node.outletId))
        throw new HttpError(
          403,
          "FORBIDDEN",
          "The sealed selfie does not belong to this outlet.",
        );
      if (!sameId(sha256(webp).toString("hex"), meta.plainSha256))
        throw cannotDecrypt();
      const owner = (
        await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, node.tenantId),
              eq(employees.userId, meta.ownerUserId),
            ),
          )
          .limit(1)
      )[0];
      if (!owner)
        throw new HttpError(
          403,
          "FORBIDDEN",
          "The selfie owner is not an employee of this tenant.",
        );

      const image = await processImage(
        webp,
        storagePurposePolicy[SELFIE_PURPOSE].maxBytes,
        deps.scanner,
      );
      const key = `${input.objectId}/original.webp`;
      const thumbnailKey = `${input.objectId}/thumbnail.webp`;
      // Claim the object id BEFORE writing S3. Outlet RLS hides an object of
      // another outlet from the check above, so the primary key is the final
      // guard: a taken id is a 409 and nothing is written to storage (the S3
      // put must never overwrite the files of an object this call did not own).
      const claimedRows = await tx
        .insert(coreStorageObjects)
        .values({
          tenantId: node.tenantId,
          outletId: node.outletId,
          id: input.objectId,
          purpose: SELFIE_PURPOSE,
          objectKey: key,
          thumbnailKey,
          contentType: "image/webp",
          sizeBytes: image.full.bytes.byteLength,
          width: image.full.width,
          height: image.full.height,
          ownerUserId: meta.ownerUserId,
          sourceKind: "attendance",
          sourceId: null,
        })
        .onConflictDoNothing()
        .returning({ id: coreStorageObjects.id });
      if (claimedRows.length === 0)
        throw new HttpError(
          409,
          "OBJECT_ID_TAKEN",
          "This object id is already in use.",
        );
      await deps.storage.put(context, {
        ...base,
        key,
        contentType: "image/webp",
        content: new Uint8Array(image.full.bytes),
      });
      written.push(key);
      await deps.storage.put(context, {
        ...base,
        key: thumbnailKey,
        contentType: "image/webp",
        content: new Uint8Array(image.thumbnail.bytes),
      });
      written.push(thumbnailKey);
      await tx.insert(edgeReceivedSelfies).values({
        tenantId: node.tenantId,
        objectId: input.objectId,
        outletId: node.outletId,
        edgeNodeId: node.edgeNodeId,
        sealedSha256: sealedHash,
        state: "stored",
        ...(deps.now && { receivedAt: deps.now() }),
      });
      await linkEdgeSelfie(tx, {
        tenantId: node.tenantId,
        objectId: input.objectId,
      });
      return { status: 201 };
    });
  } catch (error) {
    // The transaction rolled back: take back what this call wrote to S3.
    await Promise.allSettled(
      written.map((key) => deps.storage.delete(context, { ...base, key })),
    );
    throw error;
  }
}
