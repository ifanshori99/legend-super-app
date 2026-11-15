// Browser transport behaviour with native FormData and fetch. Vite-only env
// modules are stubbed at their module boundary; the actual uploader runs.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

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
    if (specifier.startsWith("@/")) {
      const suffix = specifier.endsWith(".ts") ? "" : ".ts";
      return nextResolve(
        new URL(
          `../apps/web/src/${specifier.slice(2)}${suffix}`,
          import.meta.url,
        ).href,
        context,
      );
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { uploadAttendanceSelfie } =
  await import("../apps/web/src/features/ws10-hris-employee/selfie.ts");
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const effectiveOutletId = "00000000-0000-4000-8000-000000000002";
const objectId = "00000000-0000-4000-8000-000000000003";
const policy = {
  data: {
    outletId: effectiveOutletId,
    geofenceRadiusM: 100,
    outsideGeofenceAction: "flag",
    unboundDeviceAction: "flag",
    requireSelfie: true,
    requireDeviceBinding: false,
    allowRotatingQr: true,
  },
};
const object = {
  data: {
    id: objectId,
    purpose: "selfie",
    contentType: "image/webp",
    sizeBytes: 42,
    width: 64,
    height: 48,
    publicUrl: null,
    thumbnailUrl: null,
  },
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("[legend-bf20 HR-01/02] real uploader uses the server effective outlet and returns its private object id", async () => {
  const calls = [];
  const photo = new Blob(["photo bytes"], { type: "image/jpeg" });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? json(policy) : json(object, 201);
  };
  assert.equal(await uploadAttendanceSelfie(photo), objectId);
  assert.equal(calls.length, 2);
  assert.equal(
    new URL(calls[0].url).pathname,
    "/api/hris/me/attendance-policy",
  );
  assert.equal(new URL(calls[1].url).pathname, "/api/storage/uploads");
  assert.equal(new URL(calls[1].url).origin, "https://api.example.test");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[1].init.credentials, "include");
  assert.equal(calls[1].init.method, "POST");
  const form = calls[1].init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual([...form.keys()].sort(), ["file", "outletId", "purpose"]);
  assert.equal(form.get("purpose"), "selfie");
  assert.equal(form.get("outletId"), effectiveOutletId);
  assert.equal(await form.get("file").text(), "photo bytes");
  assert.equal(new Headers(calls[1].init.headers).get("Content-Type"), null);
});

test("[legend-bf20 TEN-03] a refused policy read prevents the upload and preserves the API error", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json(
      { error: { code: "FORBIDDEN", message: "Tidak diizinkan." } },
      403,
    );
  };
  await assert.rejects(
    uploadAttendanceSelfie(new Blob(["photo"])),
    (error) =>
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === "FORBIDDEN",
  );
  assert.equal(calls, 1);
});

test("[legend-bf20 HR-02] scanner refusal reaches the caller without a synthetic photo reference", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? json(policy)
      : json(
          { error: { code: "UPLOAD_REJECTED", message: "Berkas ditolak." } },
          422,
        );
  await assert.rejects(
    uploadAttendanceSelfie(new Blob(["photo"])),
    (error) =>
      error instanceof ApiError &&
      error.status === 422 &&
      error.code === "UPLOAD_REJECTED",
  );
  assert.equal(calls, 2);
});

test("[legend-bf20 HR-02] upload network failure produces the existing network error", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return json(policy);
    throw new TypeError("offline");
  };
  await assert.rejects(
    uploadAttendanceSelfie(new Blob(["photo"])),
    (error) =>
      error instanceof ApiError &&
      error.status === 0 &&
      error.code === "NETWORK_ERROR",
  );
});

test("[legend-bf20 HR-02] malformed success cannot become a clock selfie reference", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? json(policy) : json({ data: { id: objectId } }, 201);
  await assert.rejects(uploadAttendanceSelfie(new Blob(["photo"])));
  assert.equal(calls, 2);
});
