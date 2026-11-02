// Camera capture and selfie transport for attendance (PRD F25 "Absensi
// selfie", §4 Alur L step 1). The contract carries only a `photoUploadRef`
// (a pre-signed upload reference), never photo bytes: the bytes go to the
// private bucket through the storage adapter and the API keeps the key.
//
// Storage upload is the WS-00 storage bead's surface and has no client
// endpoint yet, so `uploadAttendanceSelfie` is a port: mock mode returns a
// synthetic reference (the whole screen stays clickable), a real build fails
// closed with a readable error instead of sending an empty ref. Follow-up bead
// in the report.

import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";

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
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    SELFIE_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Peramban tidak bisa menggambar foto.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToBlob(canvas);
}

async function mockRef(blob: Blob): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await blob.arrayBuffer(),
    );
    const hex = [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `mock-selfie/${hex}`;
  } catch {
    return `mock-selfie/${Math.random().toString(16).slice(2, 18)}`;
  }
}

/**
 * Uploads the selfie and answers the reference the clock contract accepts.
 * Mock mode: a deterministic synthetic ref. Real mode: fails closed until the
 * storage upload endpoint lands (the API would otherwise store an empty ref).
 */
export async function uploadAttendanceSelfie(blob: Blob): Promise<string> {
  if (API_MOCK) return mockRef(blob);
  throw new ApiError(
    503,
    "SELFIE_UPLOAD_UNAVAILABLE",
    "Unggah selfie belum tersedia di lingkungan ini. Hubungi admin.",
  );
}
