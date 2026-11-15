import { apiErrorBodySchema } from "@starter/shared/core";
import {
  createStorageSignedUrl,
  getStorageCapabilities,
  storagePurposePolicy,
  uploadStorageMetadataSchema,
  uploadStorageObject,
  type StorageObject,
  type StorageVariant,
  type UploadStorageMetadata,
} from "@starter/shared/storage";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";
import { IMAGE_MAX_BYTES } from "./image";

export { normalizeImageFile } from "./image";

export type UploadStorageFileInput = UploadStorageMetadata & {
  file: Blob;
  filename?: string;
  signal?: AbortSignal;
};

export type StorageObjectUrl = {
  url: string;
  expiresAt: string;
};

// Mock URLs stay local to this browser; bounded storage also releases blobs
// while a long-lived demo is used to upload many files.
const mockObjects = new Map<string, { url: string; image: boolean }>();
const MOCK_OBJECT_LIMIT = 50;

async function storageRequest(
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, API_URL), {
      credentials: "include",
      ...init,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  const payload: unknown = await response.json().catch((error: unknown) => {
    if (init.signal?.aborted) throw error;
    return null;
  });
  init.signal?.throwIfAborted();
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(payload);
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }
  return payload;
}

function assertUploadSize(
  file: Blob,
  purpose: UploadStorageMetadata["purpose"],
) {
  const policyLimit = storagePurposePolicy[purpose].maxBytes;
  if (
    file.size > policyLimit ||
    (file.type.startsWith("image/") && file.size >= IMAGE_MAX_BYTES)
  ) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "fileTooLarge");
  }
}

function mockStorageUpload(
  metadata: UploadStorageMetadata,
  file: Blob,
): StorageObject {
  const url = URL.createObjectURL(file);
  const object = uploadStorageObject.response.parse({
    data: {
      id: crypto.randomUUID(),
      purpose: metadata.purpose,
      contentType: file.type,
      sizeBytes: file.size,
      width: null,
      height: null,
      publicUrl:
        storagePurposePolicy[metadata.purpose].visibility === "public"
          ? url
          : null,
      thumbnailUrl: null,
    },
  }).data;
  mockObjects.set(object.id, { url, image: file.type.startsWith("image/") });
  if (mockObjects.size > MOCK_OBJECT_LIMIT) {
    const oldestId = mockObjects.keys().next().value;
    if (oldestId !== undefined) {
      const oldest = mockObjects.get(oldestId);
      if (oldest) URL.revokeObjectURL(oldest.url);
      mockObjects.delete(oldestId);
    }
  }
  return object;
}

/**
 * Uploads a prepared file without another lossy encode. For camera/gallery files:
 * uploadStorageFile({ ...metadata, file: await normalizeImageFile(file) }).
 */
export async function uploadStorageFile({
  file,
  filename,
  signal,
  ...input
}: UploadStorageFileInput): Promise<StorageObject> {
  signal?.throwIfAborted();
  const metadata = uploadStorageMetadataSchema.parse(input);
  assertUploadSize(file, metadata.purpose);
  if (API_MOCK) return mockStorageUpload(metadata, file);
  const body = new FormData();
  body.set("purpose", metadata.purpose);
  if (metadata.outletId !== undefined) body.set("outletId", metadata.outletId);
  if (metadata.sourceKind !== undefined)
    body.set("sourceKind", metadata.sourceKind);
  body.set(
    "file",
    file,
    filename ?? (file instanceof File ? file.name : "upload"),
  );
  const { data } = uploadStorageObject.response.parse(
    await storageRequest(uploadStorageObject.path, {
      method: "POST",
      signal,
      headers: { accept: "application/json" },
      // The browser supplies the multipart boundary; do not set Content-Type.
      body,
    }),
  );
  return data;
}

/** The API owns the 300-second lifetime and authorizes every signed URL. */
export async function fetchStorageObjectUrl(
  objectId: string,
  variant: StorageVariant = "original",
  signal?: AbortSignal,
): Promise<StorageObjectUrl> {
  signal?.throwIfAborted();
  const params = createStorageSignedUrl.params.parse({ objectId });
  const body = createStorageSignedUrl.body.parse({ variant });
  if (API_MOCK) {
    const object = mockObjects.get(params.objectId);
    if (!object || (body.variant === "thumbnail" && !object.image))
      throw new ApiError(404, "NOT_FOUND", "Object not found.");
    return {
      url: object.url,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  const path = createStorageSignedUrl.path.replace(
    ":objectId",
    encodeURIComponent(params.objectId),
  );
  return createStorageSignedUrl.response.parse(
    await storageRequest(path, {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  ).data;
}

// What the upload pipeline accepts (e.g. whether PDFs may be offered).
export const fetchStorageCapabilities = (signal?: AbortSignal) =>
  callEndpoint(getStorageCapabilities, {}, { signal });
