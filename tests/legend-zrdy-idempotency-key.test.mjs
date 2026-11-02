// Shared web idempotency-key helper (bead legend-zrdy). The edge node may serve
// the app over plain http on a LAN address, where crypto.randomUUID does not
// exist; the fallback must still produce a real RFC 4122 v4 UUID.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdempotencyKey } from "../apps/web/src/lib/idempotency.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("legend-zrdy newIdempotencyKey uses crypto.randomUUID in a secure context", () => {
  let fallbacks = 0;
  const source = {
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
    getRandomValues: (bytes) => {
      fallbacks += 1;
      return bytes;
    },
  };
  assert.equal(
    newIdempotencyKey(source),
    "11111111-2222-4333-8444-555555555555",
  );
  assert.equal(fallbacks, 0);
});

test("legend-zrdy newIdempotencyKey builds an RFC 4122 v4 UUID without randomUUID", () => {
  // Bytes 0..15 prove the version and variant nibbles are set, not copied.
  const source = {
    getRandomValues: (bytes) => {
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = index;
      return bytes;
    },
  };
  assert.equal(
    newIdempotencyKey(source),
    "00010203-0405-4607-8809-0a0b0c0d0e0f",
  );
  assert.match(newIdempotencyKey(source), V4);
});

test("legend-zrdy newIdempotencyKey falls back when randomUUID throws or is missing", () => {
  const throwing = {
    randomUUID: () => {
      throw new Error("not allowed here");
    },
    getRandomValues: (bytes) => crypto.getRandomValues(bytes),
  };
  assert.match(newIdempotencyKey(throwing), V4);
  assert.match(
    newIdempotencyKey({ getRandomValues: (b) => crypto.getRandomValues(b) }),
    V4,
  );
  assert.match(newIdempotencyKey(), V4);
});

test("legend-zrdy newIdempotencyKey returns unique keys from getRandomValues", () => {
  const source = { getRandomValues: (bytes) => crypto.getRandomValues(bytes) };
  const keys = new Set();
  for (let index = 0; index < 100; index += 1)
    keys.add(newIdempotencyKey(source));
  assert.equal(keys.size, 100);
});
