// Cursor (keyset) pagination for every new list endpoint. Offset paging stays
// only on the starter's Notes example. Request: ?cursor=<opaque>&limit=25.
// Response: { data: T[], meta: { limit, nextCursor } }; nextCursor null = last
// page. The cursor encodes the sort-key tuple of the last row returned (for
// example [createdAt, id]); clients treat it as opaque and never build one.

import { z } from "zod";

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;
/**
 * One limit for both directions: encodeCursor never emits, and the query
 * schema never accepts, a cursor longer than this. 1024 base64url characters
 * hold 768 bytes of UTF-8 JSON: enough for [isoTimestamp, ulid, name <= 150
 * chars of any script]. Sort keys must be bounded columns, never free text.
 */
export const CURSOR_MAX_LENGTH = 1024;

export const cursorSchema = z.string().min(1).max(CURSOR_MAX_LENGTH);

export const cursorPageQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export const cursorPageMetaSchema = z.object({
  limit: z.number().int().min(1).max(PAGE_LIMIT_MAX),
  nextCursor: cursorSchema.nullable(),
});

export function cursorPageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({ data: z.array(item), meta: cursorPageMetaSchema });
}

export type CursorPage<T> = {
  data: T[];
  meta: z.infer<typeof cursorPageMetaSchema>;
};

export type CursorKey = string | number | boolean | null;

// UTF-8 + base64url by hand: no Buffer (Node-only) and no btoa/atob, so the
// same code runs in the API, the web app and the edge.
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
type TextCodec = {
  TextEncoder: new () => { encode(text: string): Uint8Array };
  TextDecoder: new (
    label: string,
    options: { fatal: boolean },
  ) => { decode(bytes: Uint8Array): string };
};
const codec = globalThis as unknown as TextCodec;

function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      (bytes[index] << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let position = 0; position < chars; position += 1)
      text += ALPHABET[(chunk >> (18 - position * 6)) & 63];
  }
  return text;
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new RangeError("Invalid cursor");
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 4) {
    const group = text.slice(index, index + 4);
    let chunk = 0;
    for (let position = 0; position < 4; position += 1)
      chunk =
        (chunk << 6) |
        (position < group.length ? ALPHABET.indexOf(group[position]) : 0);
    const count = Math.floor((group.length * 6) / 8);
    for (let position = 0; position < count; position += 1)
      bytes.push((chunk >> (16 - position * 8)) & 255);
  }
  return new Uint8Array(bytes);
}

const keysetSchema = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .min(1);

/**
 * Encodes the sort-key tuple of the last returned row as an opaque cursor.
 * Throws RangeError if the result would exceed CURSOR_MAX_LENGTH, so a server
 * can never hand out a cursor its own query schema would reject.
 */
export function encodeCursor(keys: readonly CursorKey[]): string {
  const cursor = toBase64Url(
    new codec.TextEncoder().encode(JSON.stringify(keys)),
  );
  if (cursor.length > CURSOR_MAX_LENGTH)
    throw new RangeError(
      `Cursor is ${cursor.length} characters; the limit is ${CURSOR_MAX_LENGTH}. Sort on bounded keys.`,
    );
  return cursor;
}

/** Decodes a cursor; throws RangeError (map to VALIDATION_ERROR) if tampered. */
export function decodeCursor(cursor: string): CursorKey[] {
  if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError("Invalid cursor");
  try {
    const json = new codec.TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64Url(cursor),
    );
    return keysetSchema.parse(JSON.parse(json));
  } catch {
    throw new RangeError("Invalid cursor");
  }
}
