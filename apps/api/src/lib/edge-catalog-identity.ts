import { createHash } from "node:crypto";
import type { CatalogSyncStream } from "@starter/shared/edge";

/** Stable UUIDv8 for one stream/document key, shared by both receive paths. */
export function catalogRecordIdFromKeys(
  stream: CatalogSyncStream,
  keys: readonly string[],
): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([stream, ...keys.map((key) => key.toLowerCase())]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
