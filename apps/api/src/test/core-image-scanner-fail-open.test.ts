import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  processImage,
  processImageFull,
  scanUpload,
  type MalwareScanner,
} from "../services/core-image";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";

// legend-w9hwh (M4): image path is fail-open ONLY for a scanner that declares
// failOpenForImages === true and fails with 503 (never 422). Documents (PDF,
// via scanUpload) stay fail-closed. Assumption: the warning goes through the
// shared `logger.warn`.

afterEach(() => vi.restoreAllMocks());

async function sample() {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: "blue" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

function scannerThatFails(
  failure: () => Error,
  failOpenForImages?: boolean,
): MalwareScanner & { scan: ReturnType<typeof vi.fn> } {
  return {
    ...(failOpenForImages === undefined ? {} : { failOpenForImages }),
    scan: vi.fn(async () => {
      throw failure();
    }),
  };
}

const unavailable = () =>
  new HttpError(
    503,
    "SCANNER_UNAVAILABLE",
    "File scanning is temporarily unavailable.",
  );

describe("legend-w9hwh image path fails open for clamd-style scanners", () => {
  it("still re-encodes the image (WebP, EXIF stripped) when the scanner is down with 503", async () => {
    const warn = vi.spyOn(logger, "warn");
    const scanner = scannerThatFails(unavailable, true);
    const output = await processImage(await sample(), 10_000_000, scanner);

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(output.full.contentType).toBe("image/webp");
    const meta = await sharp(output.full.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(output.thumbnail.contentType).toBe("image/webp");
    expect(warn).toHaveBeenCalled();
  });

  it("fails open on an unexpected (non-HttpError) scanner failure too", async () => {
    const scanner = scannerThatFails(() => new Error("socket exploded"), true);
    const output = await processImage(await sample(), 10_000_000, scanner);
    expect(output.full.contentType).toBe("image/webp");
  });

  it("logs a warning without the image bytes or any file name", async () => {
    const warn = vi.spyOn(logger, "warn");
    const input = await sample();
    await processImage(input, 10_000_000, scannerThatFails(unavailable, true));
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      for (const arg of call) {
        expect(Buffer.isBuffer(arg)).toBe(false);
        expect(arg instanceof Uint8Array).toBe(false);
      }
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      input.toString("base64").slice(0, 40),
    );
  });

  it("fails open for the full-size-only variant used by the edge selfie path", async () => {
    const scanner = scannerThatFails(unavailable, true);
    const { full } = await processImageFull(
      await sample(),
      10_000_000,
      scanner,
    );
    expect(full.contentType).toBe("image/webp");
  });

  it("still rejects a detection (422) and does not process the image", async () => {
    const scanner = scannerThatFails(
      () =>
        new HttpError(
          422,
          "UPLOAD_REJECTED",
          "Berkas ditolak pemindai malware.",
        ),
      true,
    );
    await expect(
      processImage(await sample(), 10_000_000, scanner),
    ).rejects.toMatchObject({ status: 422, code: "UPLOAD_REJECTED" });
  });

  it("does not skip validation: a forged image still fails when the scanner is down", async () => {
    const scanner = scannerThatFails(unavailable, true);
    await expect(
      processImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 1000, scanner),
    ).rejects.toThrow();
    await expect(processImage(Buffer.alloc(11), 10, scanner)).rejects.toThrow();
  });

  it("passes a clean scan through as usual", async () => {
    const scanner: MalwareScanner & { scan: ReturnType<typeof vi.fn> } = {
      failOpenForImages: true,
      scan: vi.fn(async () => {}),
    };
    const output = await processImage(await sample(), 10_000_000, scanner);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(output.full.contentType).toBe("image/webp");
  });
});

describe("legend-w9hwh scanners without the flag stay fail-closed", () => {
  it("is fail-closed when failOpenForImages is absent", async () => {
    await expect(
      processImage(await sample(), 10_000_000, scannerThatFails(unavailable)),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
  });

  it("is fail-closed when failOpenForImages is false", async () => {
    await expect(
      processImage(
        await sample(),
        10_000_000,
        scannerThatFails(unavailable, false),
      ),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
  });
});

describe("legend-w9hwh documents (PDF) are always fail-closed", () => {
  it("scanUpload answers 503 even for a failOpenForImages scanner", async () => {
    const scanner = scannerThatFails(unavailable, true);
    await expect(
      scanUpload(scanner, new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF"))),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
  });

  it("scanUpload keeps a 422 detection", async () => {
    const scanner = scannerThatFails(
      () =>
        new HttpError(
          422,
          "UPLOAD_REJECTED",
          "Berkas ditolak pemindai malware.",
        ),
      true,
    );
    await expect(
      scanUpload(scanner, new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF"))),
    ).rejects.toMatchObject({ status: 422, code: "UPLOAD_REJECTED" });
  });
});
