// One storage env set (legend-94xqo): STORAGE_S3_* is canonical, OBJECT_STORAGE_*
// a deprecated fallback with one warning, conflicting values refuse to start.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetStorageEnvWarning,
  resolveStorageEnv,
} from "../config/storage-env";
import { createObjectStorageFromEnv } from "../services/core-storage-runtime";
import { createStatementObjectStorage } from "../services/profit-share-statement-ports";
import { S3ObjectStorage } from "../services/core-storage-provider";
import { logger } from "../lib/logger";

const canonical = {
  STORAGE_S3_ACCESS_KEY_ID: "access",
  STORAGE_S3_SECRET_ACCESS_KEY: "secret",
  STORAGE_S3_PRIVATE_BUCKET: "legend-private",
  STORAGE_S3_PUBLIC_BUCKET: "legend-public",
  STORAGE_S3_REGION: "ap-southeast-3",
  STORAGE_PUBLIC_BASE_URL: "https://files.example.test",
};
const legacy = {
  OBJECT_STORAGE_REGION: "ap-southeast-3",
  OBJECT_STORAGE_ACCESS_KEY_ID: "access",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
  OBJECT_STORAGE_PRIVATE_BUCKET: "legend-private",
  OBJECT_STORAGE_PUBLIC_BUCKET: "legend-public",
  OBJECT_STORAGE_PUBLIC_BASE_URL: "https://files.example.test",
};

beforeEach(() => {
  resetStorageEnvWarning();
  vi.restoreAllMocks();
});

describe("storage env, one canonical set", () => {
  it("only STORAGE_S3_*: uploads and statements both get storage, no warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(createObjectStorageFromEnv(canonical)).toBeInstanceOf(
      S3ObjectStorage,
    );
    expect(createStatementObjectStorage(canonical)).toBeInstanceOf(
      S3ObjectStorage,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("only OBJECT_STORAGE_*: the fallback works and warns once, naming keys only", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(createStatementObjectStorage(legacy)).toBeInstanceOf(
      S3ObjectStorage,
    );
    expect(createObjectStorageFromEnv(legacy)).toBeInstanceOf(S3ObjectStorage);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("OBJECT_STORAGE_ACCESS_KEY_ID");
    expect(message).toContain("STORAGE_S3_*");
    for (const value of Object.values(legacy))
      expect(message).not.toContain(value);
  });

  it("a legacy endpoint keeps path-style addressing", () => {
    const { env } = resolveStorageEnv({
      ...legacy,
      OBJECT_STORAGE_ENDPOINT: "https://s3.example.test",
    });
    expect(env.STORAGE_S3_ENDPOINT).toBe("https://s3.example.test");
    expect(env.STORAGE_S3_FORCE_PATH_STYLE).toBe("true");
  });

  it("the same value under both names is fine; the canonical one wins", () => {
    const { conflicts, env } = resolveStorageEnv({ ...canonical, ...legacy });
    expect(conflicts).toEqual([]);
    expect(env.STORAGE_S3_PRIVATE_BUCKET).toBe("legend-private");
  });

  it("a conflict between the two names refuses, naming keys and no values", () => {
    const conflicting = {
      ...canonical,
      OBJECT_STORAGE_PRIVATE_BUCKET: "other-private-bucket",
    };
    for (const make of [
      createObjectStorageFromEnv,
      createStatementObjectStorage,
    ]) {
      let message = "";
      try {
        make(conflicting);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("OBJECT_STORAGE_PRIVATE_BUCKET");
      expect(message).toContain("STORAGE_S3_PRIVATE_BUCKET");
      expect(message).not.toContain("other-private-bucket");
      expect(message).not.toContain("legend-private");
    }
  });

  it("configured storage without a region refuses, no silent default", () => {
    const { STORAGE_S3_REGION: region, ...noRegion } = canonical;
    void region;
    for (const make of [
      createObjectStorageFromEnv,
      createStatementObjectStorage,
    ])
      expect(() => make(noRegion)).toThrow(/STORAGE_S3_REGION/);
    // The legacy region name satisfies it.
    const { STORAGE_S3_REGION: dropped, ...rest } = canonical;
    void dropped;
    expect(
      createObjectStorageFromEnv({
        ...rest,
        OBJECT_STORAGE_REGION: "ap-southeast-3",
      }),
    ).toBeInstanceOf(S3ObjectStorage);
  });

  it("a partial legacy set still stops, now naming the canonical keys", () => {
    expect(() =>
      createStatementObjectStorage({
        OBJECT_STORAGE_REGION: "ap-southeast-3",
      }),
    ).toThrow(/STORAGE_S3_ACCESS_KEY_ID/);
  });
});
