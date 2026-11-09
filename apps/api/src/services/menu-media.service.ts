// Menu photo transport (bead legend-lmk; PRD v1.7 §8 "Konten Menu": foto).
// The browser already downsized the image; the API stores the bytes through
// the WS-00 storage service (scan, EXIF strip, WebP) and answers a media id
// plus its public URL (`POST /api/menu/media`).
//
// Media is outlet-level storage (storage keys are tenant/outlet paths). The
// contract body carries an optional `outletId`: when present it must be an
// outlet the caller reaches (403 otherwise); when missing the API hosts the
// object under the first outlet the caller may reach (a single-outlet
// caller's own), the TEN-02 fallback.
//
// Reads resolve `mediaUrl` for stored objects while a provider is configured;
// with no provider the URL is null instead of a fabricated link.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  CoreError,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { MENU_IMAGE_MAX_BYTES } from "@starter/shared/menu";
import { coreStorageObjects, outlets } from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { NoopMalwareScanner, type MalwareScanner } from "./core-image";
import { uploadStorage } from "./core-storage";
import {
  assertPermission,
  MENU_ITEM_PERMISSION,
  type MenuMediaUrls,
} from "./menu-internals";
import { HttpError } from "../lib/http-error";

export type MenuMediaDeps = {
  storage: ObjectStorage;
  scanner?: MalwareScanner;
};

export type MenuImageUploadInput = {
  fileName: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
  width: number;
  height: number;
  /** Optional host outlet; must be reachable by the caller (403 otherwise). */
  outletId?: string;
};

const outletNotReachable = () =>
  new HttpError(403, "FORBIDDEN", "Anda tidak memiliki akses ke outlet ini.");

/**
 * The outlet a menu photo is stored under: the requested outlet when it is
 * reachable, else the caller's own outlet when scoped to one, else the first
 * outlet they reach (or the tenant's first outlet).
 */
async function mediaOutlet(
  context: ScopedTenantContext,
  requested?: string,
): Promise<OutletId> {
  if (requested !== undefined) {
    const outletId = outletIdSchema.parse(requested);
    if (context.outletScope.kind === "outlets") {
      if (!context.outletScope.outletIds.includes(outletId))
        throw outletNotReachable();
      return outletId;
    }
    // Tenant-wide reach: the outlet must still belong to this tenant (RLS
    // hides other tenants' rows, so a foreign id looks the same as a missing
    // one and answers the same 403).
    const found = await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, context.tenant.tenantId),
            eq(outlets.id, outletId),
          ),
        )
        .limit(1);
      return row;
    });
    if (!found) throw outletNotReachable();
    return outletId;
  }
  if (context.outletScope.kind === "outlets") {
    const [first] = context.outletScope.outletIds;
    if (first) return first;
  }
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, context.tenant.tenantId))
      .orderBy(asc(outlets.createdAt), asc(outlets.id))
      .limit(1);
    if (!row) throw new CoreError("NOT_FOUND", "Outlet belum tersedia.");
    return outletIdSchema.parse(row.id);
  });
}

export async function uploadMenuPhoto(
  context: ScopedTenantContext,
  actorUserId: string,
  input: MenuImageUploadInput,
  deps: MenuMediaDeps,
): Promise<{ mediaId: string; mediaUrl: string }> {
  assertTrustedScopedContext(context);
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MENU_IMAGE_MAX_BYTES)
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Gambar masih terlalu besar setelah diperkecil.",
    );
  const outletId = await mediaOutlet(context, input.outletId);
  await withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      { type: "outlet", id: outletId },
      new Date(),
    );
  });
  const object = await uploadStorage(
    db,
    context,
    { purpose: "menu_photo", outletId },
    bytes,
    {
      storage: deps.storage,
      scanner: deps.scanner ?? new NoopMalwareScanner(),
      // Authority was checked above on the same scope; the storage service
      // re-asserts the outlet is inside the context's reach.
      authorize: async () => true,
      actorUserId,
    },
  );
  if (!object.publicUrl)
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan foto belum tersedia.",
    );
  return { mediaId: object.id, mediaUrl: object.publicUrl };
}

/** Builds the read-side `mediaUrl` resolver from an object-storage provider. */
export function createMenuMediaUrls(
  storage: ObjectStorage | null,
): MenuMediaUrls {
  if (!storage) return async () => new Map();
  return async (context, mediaIds) => {
    const ids = [...new Set(mediaIds)];
    if (ids.length === 0) return new Map();
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({
          id: coreStorageObjects.id,
          outletId: coreStorageObjects.outletId,
          objectKey: coreStorageObjects.objectKey,
          purpose: coreStorageObjects.purpose,
        })
        .from(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, context.tenant.tenantId),
            inArray(coreStorageObjects.id, ids),
          ),
        ),
    );
    const urls = new Map<string, string>();
    for (const row of rows) {
      if (row.purpose !== "menu_photo") continue;
      try {
        urls.set(
          row.id,
          await storage.publicUrl(context, {
            tenantId: context.tenant.tenantId,
            outletId: outletIdSchema.parse(row.outletId),
            reference: row.id,
            key: row.objectKey,
            visibility: "public",
          }),
        );
      } catch {
        // A provider that refuses the lookup leaves mediaUrl null; the media
        // id still round-trips so nothing is lost.
      }
    }
    return urls;
  };
}
