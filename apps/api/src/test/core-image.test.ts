import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { NoopMalwareScanner, processImage } from "../services/core-image.ts";

const scanner = new NoopMalwareScanner();

async function sample() {
  return sharp({
    create: { width: 900, height: 600, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

describe("legend-ruf image pipeline (PRD §2, §7)", () => {
  it("strips EXIF and produces bounded WebP variants", async () => {
    const output = await processImage(await sample(), 10_000_000, scanner);
    expect(output.full.contentType).toBe("image/webp");
    const full = await sharp(output.full.bytes).metadata();
    const thumbnail = await sharp(output.thumbnail.bytes).metadata();
    expect(full.format).toBe("webp");
    expect(full.exif).toBeUndefined();
    expect(full.orientation).toBeUndefined();
    expect(Math.max(thumbnail.width!, thumbnail.height!)).toBeLessThanOrEqual(
      480,
    );
  });

  it("rejects oversized inputs and SVG even when its body contains image-like text", async () => {
    await expect(processImage(Buffer.alloc(11), 10, scanner)).rejects.toThrow();
    await expect(
      processImage(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
        1000,
        scanner,
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the scanner rejects input", async () => {
    const rejecting = {
      scan: async () => {
        throw new Error("malware detected");
      },
    };
    await expect(
      processImage(await sample(), 10_000_000, rejecting),
    ).rejects.toThrow("malware detected");
  });

  it("rejects forged image headers and undecodable image bodies", async () => {
    await expect(
      processImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 1000, scanner),
    ).rejects.toThrow();
  });
});
