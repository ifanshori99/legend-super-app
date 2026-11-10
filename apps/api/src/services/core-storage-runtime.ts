import { S3Client } from "@aws-sdk/client-s3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { CoreError } from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import type * as schema from "../db/schema";
import { NoopMalwareScanner, type MalwareScanner } from "./core-image";
import { S3ObjectStorage } from "./core-storage-provider";
import { signedStorageUrl, signedStorageUrlInTx } from "./core-storage";
import type { HrisFileSigner } from "./hris-contract.service";
import { toLoggableError } from "../lib/safe-error";

type Database = NodePgDatabase<typeof schema>;

/** Env names that configure the S3-compatible object storage (legend-dzh9q). */
export const STORAGE_REQUIRED_ENV = [
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_S3_PRIVATE_BUCKET",
  "STORAGE_S3_PUBLIC_BUCKET",
  "STORAGE_PUBLIC_BASE_URL",
] as const;
const STORAGE_OPTIONAL_ENV = [
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_REGION",
  "STORAGE_S3_FORCE_PATH_STYLE",
] as const;

/** What the app and the worker share once storage is configured. */
export type StorageRuntime = {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  /** Mints the 5-minute URL of a private attendance selfie (object id in). */
  fileSigner: HrisFileSigner;
};

export type StorageEnv = Readonly<Record<string, string | undefined>>;

/**
 * The object storage built from env, or null when no storage env is set at
 * all (the app then answers 503 on uploads). A partly set configuration is a
 * deployment error and throws, naming only the missing keys.
 */
export function createObjectStorageFromEnv(
  source: StorageEnv,
): S3ObjectStorage | null {
  const present = (name: string) => Boolean(source[name]?.trim());
  const anySet = [...STORAGE_REQUIRED_ENV, ...STORAGE_OPTIONAL_ENV].some(
    present,
  );
  if (!anySet) return null;
  const missing = STORAGE_REQUIRED_ENV.filter((name) => !present(name));
  if (missing.length > 0)
    throw new Error(
      `Incomplete storage configuration: set ${missing.join(", ")}.`,
    );
  const client = new S3Client({
    region: source.STORAGE_S3_REGION?.trim() || "us-east-1",
    ...(present("STORAGE_S3_ENDPOINT") && {
      endpoint: source.STORAGE_S3_ENDPOINT!.trim(),
    }),
    forcePathStyle: source.STORAGE_S3_FORCE_PATH_STYLE?.trim() === "true",
    credentials: {
      accessKeyId: source.STORAGE_S3_ACCESS_KEY_ID!.trim(),
      secretAccessKey: source.STORAGE_S3_SECRET_ACCESS_KEY!.trim(),
    },
  });
  return new S3ObjectStorage({
    client,
    privateBucket: source.STORAGE_S3_PRIVATE_BUCKET!.trim(),
    publicBucket: source.STORAGE_S3_PUBLIC_BUCKET!.trim(),
    publicBaseUrl: source.STORAGE_PUBLIC_BASE_URL!.trim(),
  });
}

/**
 * Signer for private attendance selfies. The caller (attendance service) has
 * already decided who may see the log; this still lets core-storage enforce
 * tenant, outlet scope and the private purpose, and refuses every purpose
 * except `selfie`, so the port cannot sign other private files. Returns null
 * when no URL can be minted.
 */
export function createAttendanceSelfieSigner(deps: {
  database: Database;
  storage: ObjectStorage;
  log?: Pick<Console, "error">;
}): HrisFileSigner {
  const log = deps.log ?? console;
  return async (context, storageObjectId, tx) => {
    try {
      const signerDeps = {
        storage: deps.storage,
        authorize: async (action: "upload" | "read", purpose: string) =>
          action === "read" && purpose === "selfie",
      };
      const signed = tx
        ? await signedStorageUrlInTx(
            tx,
            context,
            storageObjectId,
            "original",
            signerDeps,
          )
        : await signedStorageUrl(
            deps.database,
            context,
            storageObjectId,
            "original",
            signerDeps,
          );
      return signed.url;
    } catch (error) {
      if (
        error instanceof CoreError &&
        (error.code === "NOT_FOUND" ||
          error.code === "FORBIDDEN" ||
          error.code === "OUTLET_OUT_OF_SCOPE")
      )
        return null;
      log.error("attendance selfie signing failed", error);
      return null;
    }
  };
}

/**
 * Storage runtime from env, or null when storage is not configured. The
 * scanner is the no-op one: images are re-encoded by `processImage` and SVG is
 * refused, but no malware engine is wired yet (report risk, legend-dzh9q). PDF
 * documents are not re-encoded, so production refuses them until a real
 * scanner replaces the no-op one.
 */
export function createStorageRuntimeFromEnv(
  source: StorageEnv,
  database: Database,
  log?: Pick<Console, "error">,
): StorageRuntime | null {
  const storage = createObjectStorageFromEnv(source);
  if (!storage) return null;
  return {
    storage,
    scanner: new NoopMalwareScanner({
      acceptsDocuments: source.NODE_ENV !== "production",
    }),
    fileSigner: createAttendanceSelfieSigner({ database, storage, log }),
  };
}

/**
 * The `Pick<Console, "error" | "info">` the signer and the purge job log through, on top
 * of a pino logger so the lines get its redaction and request id.
 */
export function consoleLikeLog(logger: {
  error: (obj: object, message: string) => void;
  info: (obj: object, message: string) => void;
}): Pick<Console, "error" | "info"> {
  return {
    info: (message?: unknown) => logger.info({}, String(message)),
    error: (message?: unknown, error?: unknown) =>
      logger.error({ err: toLoggableError(error) }, String(message)),
  };
}
