// A media reference stored on another row (brand logo, theme logo) must be an
// object of the caller's own tenant media library; a bare uuid would let one
// tenant point at another tenant's file (TEN-10, legend-iiqx, legend-ja7i7).
// The refusal is the same for "other tenant" and "does not exist", so it is no
// existence oracle. Purpose is not restricted: storage re-checks purpose
// permissions on every read (core-storage.ts).
import { and, eq } from "drizzle-orm";
import { coreStorageObjects } from "../db/schema/index.ts";
import type { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

export async function assertTenantMedia(
  tx: Tx,
  tenantId: string,
  mediaId: string | null | undefined,
  label: string,
): Promise<void> {
  if (!mediaId) return;
  const [media] = await tx
    .select({ id: coreStorageObjects.id })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, tenantId),
        eq(coreStorageObjects.id, mediaId),
      ),
    )
    .limit(1);
  if (!media)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `${label} media not found in this tenant.`,
    );
}
