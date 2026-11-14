import { and, eq, inArray } from "drizzle-orm";
import type { StorageSourceKind } from "@starter/shared/storage";
import { coreStorageObjects } from "../db/schema/core-storage";
import { HttpError } from "../lib/http-error";
import { linkStorageObjectSource } from "./core-storage";

type EvidenceTx = Parameters<typeof linkStorageObjectSource>[0];

/** Facility evidence kinds that crew attach to a document (legend-mg2bz). */
export type FacilityEvidenceKind = Extract<
  StorageSourceKind,
  "checklist_evidence" | "maintenance_ticket" | "cleaning_task"
>;

/**
 * Media attached to a facility document must be the caller's own upload of the
 * matching source kind, stored at the document's outlet, and not attached to
 * another document. Otherwise a crew member could attach a colleague's photo
 * from the same outlet (which also changes who may read it). A file already
 * linked to THIS document (`sourceId`) passes, so a corrected answer can keep
 * its photo. Any failure is one generic 422 so ids are not probeable.
 */
export async function assertFacilityEvidenceBindable(
  tx: EvidenceTx,
  input: {
    tenantId: string;
    outletId: string;
    actorUserId: string;
    sourceKind: FacilityEvidenceKind;
    /** The document being written, when it already exists. */
    sourceId?: string;
    mediaIds: readonly string[];
    message: string;
  },
): Promise<void> {
  const ids = [...new Set(input.mediaIds)];
  if (ids.length === 0) return;
  const rows = await tx
    .select({
      id: coreStorageObjects.id,
      sourceKind: coreStorageObjects.sourceKind,
      sourceId: coreStorageObjects.sourceId,
      ownerUserId: coreStorageObjects.ownerUserId,
      uploadedBy: coreStorageObjects.uploadedBy,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, input.tenantId),
        eq(coreStorageObjects.outletId, input.outletId),
        inArray(coreStorageObjects.id, ids),
      ),
    );
  const bindable =
    rows.length === ids.length &&
    rows.every(
      (row) =>
        row.sourceKind === input.sourceKind &&
        row.uploadedBy === input.actorUserId &&
        row.ownerUserId === input.actorUserId &&
        (row.sourceId === null ||
          (input.sourceId !== undefined && row.sourceId === input.sourceId)),
    );
  if (!bindable) throw new HttpError(422, "VALIDATION_ERROR", input.message);
}

/** Marks the media as attached to the document, in the caller's transaction.
 * Files already linked to this document are left as they are. */
export async function linkFacilityEvidence(
  tx: EvidenceTx,
  input: {
    tenantId: string;
    outletId: string;
    actorUserId: string;
    sourceKind: FacilityEvidenceKind;
    sourceId: string;
    mediaIds: readonly string[];
  },
): Promise<void> {
  const ids = [...new Set(input.mediaIds)];
  if (ids.length === 0) return;
  const rows = await tx
    .select({
      id: coreStorageObjects.id,
      sourceId: coreStorageObjects.sourceId,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, input.tenantId),
        inArray(coreStorageObjects.id, ids),
      ),
    );
  const attached = new Set(
    rows.filter((row) => row.sourceId === input.sourceId).map((row) => row.id),
  );
  for (const objectId of ids) {
    if (attached.has(objectId)) continue;
    await linkStorageObjectSource(tx, {
      tenantId: input.tenantId,
      objectId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      actorUserId: input.actorUserId,
      outletId: input.outletId,
    });
  }
}
