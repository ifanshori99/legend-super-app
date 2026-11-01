import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  storageLookupSchema,
  storageRequestSchema,
  storageSignedLookupSchema,
  type ObjectStorage,
  type StorageLookup,
  type StorageRequest,
  type StorageSignedLookup,
} from "@starter/shared/adapters";

/** S3 credentials, endpoint, and path-style mode are configured on the injected SDK client. */
export class S3ObjectStorage implements ObjectStorage {
  private readonly base: string;
  constructor(
    private readonly options: {
      client: S3Client;
      privateBucket: string;
      publicBucket: string;
      publicBaseUrl: string;
      sign?: (
        client: S3Client,
        command: GetObjectCommand,
        options: { expiresIn: number },
      ) => Promise<string>;
    },
  ) {
    const url = new URL(options.publicBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      options.privateBucket === options.publicBucket ||
      !options.privateBucket ||
      !options.publicBucket
    )
      throw new TypeError("Invalid storage configuration");
    this.base = url.href.replace(/\/$/, "");
  }
  private scope(context: ScopedTenantContext, v: StorageLookup) {
    assertTrustedScopedContext(context);
    if (context.tenant.tenantId !== v.tenantId)
      throw new TypeError("Tenant mismatch");
    if (v.outletId === null) {
      if (context.outletScope.kind !== "tenant")
        throw new CoreError(
          "OUTLET_OUT_OF_SCOPE",
          "Anda tidak memiliki akses ke operasi tingkat tenant.",
        );
    } else assertOutletInScope(context.outletScope, v.outletId);
    return {
      Bucket:
        v.visibility === "public"
          ? this.options.publicBucket
          : this.options.privateBucket,
      Key: `${v.tenantId}/${v.outletId ?? "tenant"}/${v.key}`,
    };
  }
  async put(context: ScopedTenantContext, input: StorageRequest) {
    const v = storageRequestSchema.parse(input);
    const path = this.scope(context, v);
    await this.options.client.send(
      new PutObjectCommand({
        ...path,
        Body:
          typeof v.content === "string" ? Buffer.from(v.content) : v.content,
        ContentType: v.contentType,
        Metadata: {
          encoding: typeof v.content === "string" ? "utf8" : "binary",
        },
      }),
    );
    return { reference: v.reference, accepted: true };
  }
  async get(
    context: ScopedTenantContext,
    input: StorageLookup,
  ): Promise<StorageRequest> {
    const v = storageLookupSchema.parse(input);
    const path = this.scope(context, v);
    try {
      const object = await this.options.client.send(new GetObjectCommand(path));
      if (!object.Body || !object.ContentType)
        throw new Error("Invalid stored object");
      const bytes = await object.Body.transformToByteArray();
      return {
        ...v,
        contentType: object.ContentType,
        content:
          object.Metadata?.encoding === "utf8"
            ? Buffer.from(bytes).toString("utf8")
            : new Uint8Array(bytes),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound")
      )
        throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
      throw error;
    }
  }
  async delete(context: ScopedTenantContext, input: StorageLookup) {
    const v = storageLookupSchema.parse(input);
    await this.options.client.send(
      new DeleteObjectCommand(this.scope(context, v)),
    );
  }
  async signedGetUrl(context: ScopedTenantContext, input: StorageSignedLookup) {
    const v = storageSignedLookupSchema.parse(input);
    const path = this.scope(context, v);
    if (v.visibility === "public")
      throw new TypeError("Private object required");
    return (this.options.sign ?? getSignedUrl)(
      this.options.client,
      new GetObjectCommand(path),
      { expiresIn: v.expiresInSeconds },
    );
  }
  async publicUrl(context: ScopedTenantContext, input: StorageLookup) {
    const v = storageLookupSchema.parse(input);
    const path = this.scope(context, v);
    if (v.visibility !== "public")
      throw new TypeError("Public object required");
    return `${this.base}/${path.Key.split("/").map(encodeURIComponent).join("/")}`;
  }
}
