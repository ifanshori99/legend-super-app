/** Client image budget; the API independently checks and re-encodes uploads. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_EDGE_PX = 2560;

export type NormalizeImageOptions = {
  maxEdgePx?: number;
  quality?: number;
  maxBytes?: number;
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
};

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Some phone formats decode through the native image element only.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("fileWrongType"));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== "image/jpeg") {
          reject(new Error("fileWrongType"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

/** Re-encodes camera/gallery images before upload; input may exceed 5 MiB. */
export async function normalizeImageFile(
  file: Blob,
  {
    maxEdgePx = IMAGE_MAX_EDGE_PX,
    quality = 0.85,
    maxBytes = IMAGE_MAX_BYTES,
  }: NormalizeImageOptions = {},
): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("fileWrongType");
  if (
    !Number.isFinite(maxEdgePx) ||
    maxEdgePx < 1 ||
    !Number.isFinite(maxBytes) ||
    maxBytes < 1 ||
    !Number.isFinite(quality) ||
    quality <= 0 ||
    quality > 1
  ) {
    throw new RangeError("Invalid image normalization options.");
  }
  const image = await decodeImage(file);
  try {
    if (image.width <= 0 || image.height <= 0) throw new Error("fileWrongType");
    const scale = Math.min(1, maxEdgePx / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Peramban tidak bisa menggambar foto.");
    context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    // Lower quality when a very detailed photo still exceeds the byte budget.
    for (const factor of [1, 0.8, 0.6, 0.4]) {
      const blob = await jpegBlob(canvas, quality * factor);
      if (blob.size < Math.min(maxBytes, IMAGE_MAX_BYTES)) return blob;
    }
    throw new Error("fileTooLarge");
  } finally {
    image.dispose();
  }
}
