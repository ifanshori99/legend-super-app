import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalBitmap = globalThis.createImageBitmap;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/mock-flag")
      return {
        url: "data:text/javascript,export const API_MOCK=false",
        shortCircuit: true,
      };
    if (specifier === "@/lib/env")
      return {
        url: "data:text/javascript,export const API_URL='https://api.example.test'",
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return nextResolve(
        new URL(`../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
        context,
      );
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const outletId = "00000000-0000-4000-8000-000000000002";
const objectId = "00000000-0000-4000-8000-000000000003";
const imageBytes = 5 * 1024 * 1024;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function object(purpose = "receipt") {
  return {
    id: objectId,
    purpose,
    contentType: "image/webp",
    sizeBytes: 42,
    width: 2560,
    height: 1280,
    publicUrl: null,
    thumbnailUrl: null,
  };
}

function browserImage({
  width = 6000,
  height = 3000,
  bytes = 32,
  type = "image/jpeg",
  failDraw = false,
} = {}) {
  let closed = 0;
  const encodes = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {
        if (failDraw) throw new Error("draw failed");
      },
    }),
    toBlob: (callback, mime, quality) => {
      encodes.push({
        mime,
        quality,
        width: canvas.width,
        height: canvas.height,
      });
      callback(new Blob([new Uint8Array(bytes)], { type }));
    },
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.createImageBitmap = async () => ({
    width,
    height,
    close: () => {
      closed++;
    },
  });
  return { canvas, encodes, closed: () => closed };
}

async function imageModule() {
  return import("../apps/web/src/features/storage/image.ts");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  globalThis.createImageBitmap = originalBitmap;
});

test("[legend-avf8m M1-01] normalizes a landscape phone photo to JPEG with a 2560px longest edge", async () => {
  const { normalizeImageFile } = await imageModule();
  const browser = browserImage();
  const result = await normalizeImageFile(
    new File(["source"], "camera.png", { type: "image/png" }),
  );
  assert.equal(result.type, "image/jpeg");
  assert.deepEqual([browser.canvas.width, browser.canvas.height], [2560, 1280]);
  assert.equal(browser.encodes[0].mime, "image/jpeg");
  assert.equal(browser.encodes[0].quality, 0.85);
  assert.equal(browser.closed(), 1);
});

test("[legend-avf8m M1-01] compresses an input over 5MiB before enforcing the output limit", async () => {
  const { normalizeImageFile } = await imageModule();
  browserImage({ width: 3000, height: 6000 });
  const result = await normalizeImageFile(
    new File([new Uint8Array(8 * 1024 * 1024)], "phone.jpg", {
      type: "image/jpeg",
    }),
  );
  assert.ok(result.size < imageBytes);
});

test("[legend-avf8m M1-01] preserves a small image size and rejects a normalized result at the strict 5MiB boundary", async () => {
  const { normalizeImageFile } = await imageModule();
  const small = browserImage({ width: 400, height: 800 });
  await normalizeImageFile(
    new File(["small"], "small.webp", { type: "image/webp" }),
  );
  assert.deepEqual([small.canvas.width, small.canvas.height], [400, 800]);
  browserImage({ bytes: imageBytes });
  await assert.rejects(
    normalizeImageFile(
      new File(["large"], "large.jpg", { type: "image/jpeg" }),
    ),
  );
});

test("[legend-avf8m M1-01] rejects non-images before attempting browser decoding", async () => {
  const { normalizeImageFile } = await imageModule();
  let decoded = false;
  globalThis.createImageBitmap = async () => {
    decoded = true;
    throw new Error("should not decode");
  };
  await assert.rejects(
    normalizeImageFile(
      new File(["pdf"], "scan.pdf", { type: "application/pdf" }),
    ),
  );
  assert.equal(decoded, false);
});

test("[legend-avf8m M1-02] uploads normalized multipart with authenticated cookies and validated metadata", async () => {
  const { uploadStorageFile } =
    await import("../apps/web/src/features/storage/api.ts");
  const { normalizeImageFile } = await imageModule();
  browserImage();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json({ data: object() }, 201);
  };
  const result = await uploadStorageFile({
    purpose: "receipt",
    sourceKind: "goods_receipt",
    outletId,
    file: await normalizeImageFile(
      new File(["source"], "camera.png", { type: "image/png" }),
    ),
  });
  assert.equal(result.id, objectId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/api/storage/uploads");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.method, "POST");
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("purpose"), "receipt");
  assert.equal(form.get("sourceKind"), "goods_receipt");
  assert.equal(form.get("outletId"), outletId);
  assert.equal(form.get("file").type, "image/jpeg");
  assert.ok(form.get("file").size < imageBytes);
  assert.equal(new Headers(calls[0].init.headers).get("Content-Type"), null);
});

test("[legend-avf8m M1-02] rejects image bytes at 5MiB before any upload request", async () => {
  const { uploadStorageFile } =
    await import("../apps/web/src/features/storage/api.ts");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ data: object() });
  };
  await assert.rejects(
    uploadStorageFile({
      purpose: "receipt",
      sourceKind: "goods_receipt",
      outletId,
      file: new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }),
    }),
  );
  assert.equal(calls, 0);
});

for (const [status, code] of [
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
  [422, "UPLOAD_REJECTED"],
  [503, "SCANNER_UNAVAILABLE"],
]) {
  test(`[legend-avf8m M1-03] preserves ${status} ${code} and never invents a successful object`, async () => {
    const { uploadStorageFile } =
      await import("../apps/web/src/features/storage/api.ts");
    browserImage();
    globalThis.fetch = async () =>
      json(
        {
          error: {
            code,
            message: "Rejected",
            details: [{ field: "file", message: "scanner" }],
          },
        },
        status,
      );
    await assert.rejects(
      uploadStorageFile({
        purpose: "receipt",
        sourceKind: "goods_receipt",
        outletId,
        file: new File(["photo"], "photo.jpg", { type: "image/jpeg" }),
      }),
      (error) =>
        error instanceof ApiError &&
        error.status === status &&
        error.code === code &&
        error.details?.[0]?.field === "file" &&
        error.details?.[0]?.message === "scanner",
    );
  });
}

test("[legend-avf8m M1-03] rejects malformed success and preserves network failure", async () => {
  const { uploadStorageFile } =
    await import("../apps/web/src/features/storage/api.ts");
  browserImage();
  const input = {
    purpose: "receipt",
    sourceKind: "goods_receipt",
    outletId,
    file: new File(["photo"], "photo.jpg", { type: "image/jpeg" }),
  };
  globalThis.fetch = async () => json({ data: { id: objectId } });
  await assert.rejects(uploadStorageFile(input));
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  await assert.rejects(
    uploadStorageFile(input),
    (error) =>
      error instanceof ApiError &&
      error.status === 0 &&
      error.code === "NETWORK_ERROR",
  );
});

test("[legend-avf8m M1-03] preserves cancellation while the response body is being read", async () => {
  const { uploadStorageFile } =
    await import("../apps/web/src/features/storage/api.ts");
  const controller = new AbortController();
  const reason = new DOMException("Upload cancelled", "AbortError");
  const response = json({ data: object() });
  response.json = async () => {
    controller.abort(reason);
    throw reason;
  };
  globalThis.fetch = async () => response;
  await assert.rejects(
    uploadStorageFile({
      purpose: "receipt",
      sourceKind: "goods_receipt",
      outletId,
      file: new Blob(["photo"], { type: "image/jpeg" }),
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});

test("[legend-avf8m M1-04] signs original and thumbnail independently and refreshes 30 seconds before the 300 second expiry", async () => {
  const { QueryClient } = webRequire("@tanstack/react-query");
  const { storageObjectUrlQuery } =
    await import("../apps/web/src/features/storage/queries.ts");
  let calls = 0;
  const now = Date.now();
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://api.example.test/api/storage/objects/${objectId}/signed-url`,
    );
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "include");
    assert.deepEqual(JSON.parse(init.body), { variant: "thumbnail" });
    return json({
      data: {
        url: `https://storage.example.test/${calls}`,
        expiresAt: new Date(now + 300_000).toISOString(),
      },
    });
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  try {
    const options = storageObjectUrlQuery(objectId, "thumbnail");
    assert.notDeepEqual(
      options.queryKey,
      storageObjectUrlQuery(objectId, "original").queryKey,
    );
    assert.notDeepEqual(
      options.queryKey,
      storageObjectUrlQuery("00000000-0000-4000-8000-000000000004", "thumbnail")
        .queryKey,
    );
    const signed = await client.fetchQuery(options);
    assert.equal(signed.url, "https://storage.example.test/1");
    const query = client.getQueryCache().find({ queryKey: options.queryKey });
    const staleTime =
      typeof options.staleTime === "function"
        ? options.staleTime(query)
        : options.staleTime;
    const refresh =
      typeof options.refetchInterval === "function"
        ? options.refetchInterval(query)
        : options.refetchInterval;
    assert.ok(
      staleTime > 260_000 && staleTime <= 270_000,
      `staleTime ${staleTime}`,
    );
    assert.ok(
      refresh > 260_000 && refresh <= 270_000,
      `refetchInterval ${refresh}`,
    );
    await client.fetchQuery(options);
    assert.equal(calls, 1, "fresh signed URL stays cached");
  } finally {
    client.clear();
  }
});

test("[legend-avf8m M1-04] an active signed URL query refreshes automatically before expiry", async () => {
  const { QueryClient, QueryObserver, environmentManager } = webRequire(
    "@tanstack/react-query",
  );
  const { storageObjectUrlQuery } =
    await import("../apps/web/src/features/storage/queries.ts");
  environmentManager.setIsServer(() => false);
  let calls = 0;
  let resolveRefreshed;
  const refreshed = new Promise((resolve) => {
    resolveRefreshed = resolve;
  });
  const firstExpiry = Date.now() + 30_120;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) resolveRefreshed();
    return json({
      data: {
        url: `https://storage.example.test/refreshed-${calls}`,
        expiresAt: new Date(
          calls === 1 ? firstExpiry : Date.now() + 300_000,
        ).toISOString(),
      },
    });
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const observer = new QueryObserver(client, {
    ...storageObjectUrlQuery(objectId),
    refetchIntervalInBackground: true,
  });
  let unsubscribe;
  let timeout;
  try {
    unsubscribe = observer.subscribe(() => {});
    await Promise.race([
      refreshed,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Signed URL never refreshed automatically")),
          2000,
        );
      }),
    ]);
    assert.equal(calls, 2);
    assert.ok(Date.now() < firstExpiry, "refresh precedes URL expiry");
  } finally {
    clearTimeout(timeout);
    unsubscribe?.();
    client.clear();
    environmentManager.setIsServer(() => true);
  }
});

for (const [status, expected] of [
  [0, 30_000],
  [408, 30_000],
  [429, 30_000],
  [503, 30_000],
  [401, false],
  [403, false],
  [404, false],
]) {
  test(`[legend-avf8m M1-04] cached URL refresh after ${status} ${expected ? "recovers on a bounded interval" : "stops after access refusal"}`, async () => {
    const { QueryClient } = webRequire("@tanstack/react-query");
    const { storageObjectUrlQuery } =
      await import("../apps/web/src/features/storage/queries.ts");
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1)
        return json({
          data: {
            url: "https://storage.example.test/cached",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        });
      if (status === 0) throw new TypeError("offline");
      return json(
        { error: { code: "REFRESH_REFUSED", message: "Unavailable" } },
        status,
      );
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    try {
      const options = storageObjectUrlQuery(objectId);
      await client.fetchQuery(options);
      await assert.rejects(client.fetchQuery({ ...options, staleTime: 0 }));
      const query = client.getQueryCache().find({ queryKey: options.queryKey });
      assert.equal(options.refetchInterval(query), expected);
      assert.equal(
        calls,
        2,
        "refresh does not make an unbounded immediate retry",
      );
    } finally {
      client.clear();
    }
  });
}
