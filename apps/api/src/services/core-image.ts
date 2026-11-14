import sharp from "sharp";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger";

/** Replace the no-op with an actual scanner before relying on malware detection. */
export interface MalwareScanner {
  /** Resolves only when the object is accepted; rejects on detection or failure. */
  scan(bytes: Uint8Array): Promise<void>;
  /** False when this scanner cannot vet non-image documents (PDF); uploads of
   * those are refused. Absent means true. */
  readonly acceptsDocuments?: boolean;
  /** True when an image may still be processed (sharp re-encodes it) while the
   * scanner is unavailable (503). Never applies to a detection (422) or a PDF.
   * Absent means false: fail closed. */
  readonly failOpenForImages?: boolean;
  /** Liveness probe for the readiness report; resolves false, never throws. */
  ping?(): Promise<boolean>;
}

/** Fail closed when the scanner cannot complete, without exposing its diagnostics. */
export async function scanUpload(
  scanner: MalwareScanner,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await scanner.scan(bytes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 422) throw error;
    throw new HttpError(
      503,
      "SCANNER_UNAVAILABLE",
      "File scanning is temporarily unavailable.",
    );
  }
}

/**
 * Refuses a document (PDF) upload when the scanner cannot vet documents: the
 * production noop (legend-dzh9q). Call it BEFORE any blob is stored or any PDF
 * is rendered, so a refusal leaves no orphan file (legend-0w2wy). Shared by the
 * core-storage, menu print and shareholder document paths.
 */
export function assertScannerAcceptsDocuments(scanner: MalwareScanner): void {
  if (scanner.acceptsDocuments === false)
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Unggah dokumen PDF belum tersedia: pemindai malware belum dipasang.",
    );
}

/** Development fake only; it does not detect malicious content. */
export class NoopMalwareScanner implements MalwareScanner {
  readonly acceptsDocuments: boolean;

  constructor(options: { acceptsDocuments?: boolean } = {}) {
    this.acceptsDocuments = options.acceptsDocuments ?? true;
  }

  async scan(): Promise<void> {
    // Deliberately does not inspect content.
  }
}

export interface ImageVariant {
  bytes: Buffer;
  contentType: "image/webp";
  width: number;
  height: number;
}

export interface ProcessedImage {
  full: ImageVariant;
  thumbnail: ImageVariant;
}

// SVG is deliberately excluded: active content and external resources are not
// safe to serve from public buckets. Trust bytes, never a supplied MIME type.
function imageMagic(bytes: Buffer): "jpeg" | "png" | "webp" | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

/** PRD §2, §7: scan input, decode and re-encode to remove EXIF/GPS. */
export async function processImage(
  input: Uint8Array,
  maxBytes: number,
  scanner: MalwareScanner,
): Promise<ProcessedImage> {
  return processImageVariants(input, maxBytes, scanner, true);
}

/** Same checks and re-encode as `processImage`, full size only. The edge seals
 * selfies without a thumbnail (design hris-edge-replication 5), so it skips
 * the second encode. */
export async function processImageFull(
  input: Uint8Array,
  maxBytes: number,
  scanner: MalwareScanner,
): Promise<{ full: ImageVariant }> {
  const { full } = await processImageVariants(input, maxBytes, scanner, false);
  return { full };
}

async function processImageVariants(
  input: Uint8Array,
  maxBytes: number,
  scanner: MalwareScanner,
  withThumbnail: true,
): Promise<ProcessedImage>;
async function processImageVariants(
  input: Uint8Array,
  maxBytes: number,
  scanner: MalwareScanner,
  withThumbnail: boolean,
): Promise<{ full: ImageVariant; thumbnail: ImageVariant | null }>;
async function processImageVariants(
  input: Uint8Array,
  maxBytes: number,
  scanner: MalwareScanner,
  withThumbnail: boolean,
): Promise<{ full: ImageVariant; thumbnail: ImageVariant | null }> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    input.byteLength === 0 ||
    input.byteLength > maxBytes
  ) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Invalid image size.");
  }
  const bytes = Buffer.from(input);
  const magic = imageMagic(bytes);
  if (!magic)
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Unsupported image type.",
    );
  try {
    await scanUpload(scanner, bytes);
  } catch (error) {
    // The re-encode below strips everything but pixels, so an image may pass
    // while the scanner restarts. A detection (422) is never skipped.
    if (
      scanner.failOpenForImages === true &&
      error instanceof HttpError &&
      error.status === 503
    )
      logger.warn(
        {},
        "Malware scanner unavailable; image accepted after re-encode",
      );
    else throw error;
  }
  try {
    const image = sharp(bytes, {
      limitInputPixels: 50_000_000,
      failOn: "error",
    });
    const metadata = await image.metadata();
    if (metadata.format !== magic || (metadata.pages ?? 1) !== 1)
      throw new Error("Invalid image");
    const variant = async (size: number): Promise<ImageVariant> => {
      const { data, info } = await image
        .clone()
        .rotate()
        .resize({
          width: size,
          height: size,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp()
        .toBuffer({ resolveWithObject: true });
      return {
        bytes: data,
        contentType: "image/webp",
        width: info.width,
        height: info.height,
      };
    };
    const [full, thumbnail] = await Promise.all([
      variant(2560),
      withThumbnail ? variant(480) : Promise.resolve(null),
    ]);
    return { full, thumbnail };
  } catch {
    throw new HttpError(422, "INVALID_IMAGE", "Image could not be decoded.");
  }
}
