import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { NoopMalwareScanner } from "../services/core-image";
import { uploadStorage } from "../services/core-storage";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const db = drizzle(pool, { schema });
afterAll(async () => pool.end());
it("legend-ruf rejects unauthorized uploads before writing objects", async () => {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: randomUUID(),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  const input = {
    purpose: "menu_photo" as const,
    outletId: outletIdSchema.parse(randomUUID()),
  };
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(
    uploadStorage(db, context, input, bytes, {
      storage: new FakeObjectStorage(),
      scanner: new NoopMalwareScanner(),
      authorize: async () => false,
    }),
  ).rejects.toThrow();
});
