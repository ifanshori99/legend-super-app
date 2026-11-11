import { defineConfig } from "vitest/config";

// Integration tests run the real Express app, Better Auth, and services
// against a disposable PostgreSQL server. Start them with pnpm test from the
// repository root, which creates that server and supplies its URL.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["verbose"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
      // legend-lgfru: a WhatsApp challenge is refused (503) without a webhook
      // secret. Tests that issue one directly get this placeholder; tests of
      // the refusal pass `webhookSecrets: []` / `whatsappWebhookSecrets: []`.
      KIRIM_WEBHOOK_SECRET:
        process.env.KIRIM_WEBHOOK_SECRET ?? "test-kirim-webhook-secret",
    },
  },
});
