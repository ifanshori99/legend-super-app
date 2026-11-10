// Queues a sealed selfie for upload to the cloud (design section 5, 9 T5).
// The row lands in the same transaction as the attendance log, so a log that
// names an edge-sealed selfie always has an upload row. Only hashes and sizes
// are stored: the file is already sealed and its content is never read here.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OutletId, TenantId } from "@starter/shared/core";
import { edgeSelfieUploads } from "../db/schema/edge-hris.ts";
import { readLss1Header } from "../lib/selfie-seal.ts";
import type { Tx } from "../services/hris-access.ts";
import {
  edgeSealedFilePath,
  parseEdgeSealedObjectKey,
} from "./selfie-paths.ts";

export interface EnqueueEdgeSelfieInput {
  tenantId: string;
  outletId: string;
  attendanceLogId: string;
  objectKey: string;
  dir: string;
}

/** False, with nothing written, when the key is not an edge-sealed key. */
export async function enqueueEdgeSelfieUpload(
  tx: Tx,
  input: EnqueueEdgeSelfieInput,
): Promise<boolean> {
  const parsed = parseEdgeSealedObjectKey(input.objectKey);
  if (!parsed || parsed.tenantId !== input.tenantId) return false;
  const filePath = edgeSealedFilePath(
    input.dir,
    parsed.tenantId,
    parsed.objectId,
  );
  const sealed = await readFile(filePath);
  const header = readLss1Header(sealed);
  // The file must be the object the key names, for this tenant.
  if (
    header.objectId !== parsed.objectId ||
    header.tenantId !== parsed.tenantId
  )
    throw new Error("Sealed selfie header does not match its object key.");
  await tx
    .insert(edgeSelfieUploads)
    .values({
      tenantId: parsed.tenantId as TenantId,
      objectId: parsed.objectId,
      outletId: input.outletId as OutletId,
      attendanceLogId: input.attendanceLogId,
      filePath,
      sealedSha256: createHash("sha256").update(sealed).digest(),
      sealedBytes: sealed.length,
      sealKid: header.kid,
    })
    .onConflictDoNothing();
  return true;
}
