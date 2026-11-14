// Camera capture and selfie transport for attendance (PRD F25 "Absensi
// selfie", §4 Alur L step 1). The contract carries only a `photoUploadRef`
// (a pre-signed upload reference), never photo bytes: the bytes go to the
// private bucket through the storage adapter and the API keeps the key.
//
// The existing storage endpoint scans and re-encodes the private photo. The
// effective attendance policy supplies the shift outlet, so a covering employee
// uploads to the same outlet where the server will record their clock.

import { apiErrorBodySchema } from "@starter/shared/core";
import { getMyAttendancePolicy } from "@starter/shared/hris";
import { uploadStorageFile } from "@/features/storage/api";
import { normalizeImageFile } from "@/features/storage/image";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";

/** PRD "foto": phone photos are large; 5 MB is generous for one face. */
export const SELFIE_MAX_BYTES = 5_000_000;

/** Square-ish preview: enough for a supervisor review, cheap to encode. */
const SELFIE_MAX_EDGE_PX = 720;
const SELFIE_JPEG_QUALITY = 0.82;

export type SelfieFileProblem = "fileTooLarge" | "fileWrongType";

/** Cheap client-side check; the server validates content type and size too. */
export function selfieFileProblem(file: File): SelfieFileProblem | null {
  if (!file.type.startsWith("image/")) return "fileWrongType";
  if (file.size > SELFIE_MAX_BYTES) return "fileTooLarge";
  return null;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Canvas tidak bisa menghasilkan gambar.")),
      "image/jpeg",
      SELFIE_JPEG_QUALITY,
    );
  });
}

/** One frame of the live preview, scaled down and re-encoded as JPEG. */
export async function captureSelfieFrame(
  video: HTMLVideoElement,
): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0)
    throw new Error("Kamera belum siap. Tunggu pratinjau lalu ambil foto.");
  const scale = Math.min(1, SELFIE_MAX_EDGE_PX / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Peramban tidak bisa menggambar foto.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas);
}

/** A file picked from the native camera app, scaled the same way. */
export async function normalizeSelfieFile(file: File): Promise<Blob> {
  const problem = selfieFileProblem(file);
  if (problem) throw new Error(problem);
  return normalizeImageFile(file, {
    maxEdgePx: SELFIE_MAX_EDGE_PX,
    quality: SELFIE_JPEG_QUALITY,
    maxBytes: SELFIE_MAX_BYTES,
  });
}

async function selfieRequest(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, API_URL), {
      credentials: "include",
      headers: { accept: "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  const payload: unknown = await response.json().catch(() => null);
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

/** Uploads the selfie and returns the private object id the clock accepts. */
export async function uploadAttendanceSelfie(blob: Blob): Promise<string> {
  const outletId = API_MOCK
    ? (await import("@starter/shared/hris")).cafeLegendHrisFixtures.outlets[0]
        .id
    : getMyAttendancePolicy.response.parse(
        await selfieRequest(getMyAttendancePolicy.path),
      ).data.outletId;
  const object = await uploadStorageFile({
    purpose: "selfie",
    outletId,
    file: blob,
    filename: "selfie.jpg",
  });
  return object.id;
}
