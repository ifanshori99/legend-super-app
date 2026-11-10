// Production wiring of the statement issuer (bead legend-33im6, S5): the
// storage factory is env driven and the installer fills the issuer defaults.
import { afterEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  createStatementEmailProvider,
  createStatementObjectStorage,
  installProfitShareStatementPorts,
} from "../services/profit-share-statement-ports";
import { S3ObjectStorage } from "../services/core-storage-provider";
import { configureProfitShareStatementDeps } from "../services/profit-share-statement.service";

const s3Env = {
  OBJECT_STORAGE_REGION: "ap-southeast-3",
  OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
  OBJECT_STORAGE_PRIVATE_BUCKET: "legend-private",
  OBJECT_STORAGE_PUBLIC_BUCKET: "legend-public",
  OBJECT_STORAGE_PUBLIC_BASE_URL: "https://files.example.test",
};

afterEach(() => configureProfitShareStatementDeps({}));

describe("S5 statement object storage from the environment", () => {
  it("is null when no object storage is configured", () => {
    expect(createStatementObjectStorage({})).toBeNull();
    expect(
      createStatementObjectStorage({ OBJECT_STORAGE_REGION: "  " }),
    ).toBeNull();
  });

  it("builds an S3 storage when the settings are complete", () => {
    expect(createStatementObjectStorage(s3Env)).toBeInstanceOf(S3ObjectStorage);
    expect(
      createStatementObjectStorage({
        ...s3Env,
        OBJECT_STORAGE_ENDPOINT: "https://s3.example.test",
      }),
    ).toBeInstanceOf(S3ObjectStorage);
  });

  it("builds an email provider only for brevo", () => {
    expect(createStatementEmailProvider({})).toBeNull();
    expect(
      createStatementEmailProvider({ NOTIFICATION_EMAIL_PROVIDER: "disabled" }),
    ).toBeNull();
    expect(
      createStatementEmailProvider({
        NOTIFICATION_EMAIL_PROVIDER: "brevo",
        BREVO_API_KEY: "key-abc123",
        NOTIFICATION_EMAIL_FROM: "noreply@example.com",
      }),
    ).not.toBeNull();
    // A broken brevo setup never stops the API: no email, the warning is logged.
    expect(
      createStatementEmailProvider({ NOTIFICATION_EMAIL_PROVIDER: "brevo" }),
    ).toBeNull();
  });

  it("installer reports what it wired, overrides win over the environment", () => {
    expect(installProfitShareStatementPorts({})).toEqual({
      storage: false,
      email: false,
    });
    expect(installProfitShareStatementPorts(s3Env)).toEqual({
      storage: true,
      email: false,
    });
    expect(
      installProfitShareStatementPorts(
        {},
        { storage: new FakeObjectStorage() },
      ),
    ).toEqual({ storage: true, email: false });
  });
});
