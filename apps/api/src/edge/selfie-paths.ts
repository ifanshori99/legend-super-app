// Where an edge-sealed selfie lives (design section 5). The object key marks a
// core_storage_objects row whose bytes are an LSS1 file on the edge disk, not
// an object in S3.
import path from "node:path";

export const EDGE_SEALED_KEY_PREFIX = "edge-sealed:";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERN = new RegExp(
  `^${EDGE_SEALED_KEY_PREFIX}(${UUID})/(${UUID})\\.lss$`,
);

export function edgeSealedObjectKey(
  tenantId: string,
  objectId: string,
): string {
  return `${EDGE_SEALED_KEY_PREFIX}${tenantId}/${objectId}.lss`;
}

export function edgeSealedFilePath(
  dir: string,
  tenantId: string,
  objectId: string,
): string {
  return path.join(dir, tenantId, `${objectId}.lss`);
}

/** Strict: lowercase uuid/uuid only, so a key can never name another path. */
export function parseEdgeSealedObjectKey(
  key: string,
): { tenantId: string; objectId: string } | null {
  const match = KEY_PATTERN.exec(key);
  return match
    ? { tenantId: match[1] as string, objectId: match[2] as string }
    : null;
}
