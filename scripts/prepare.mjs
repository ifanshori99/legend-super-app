import { assertNode, prepareEnvironment, runPnpm, root } from "./lib.mjs";
import { managesLocalDatabase } from "./postgres.mjs";
import { provisionRoles } from "./provision-app-role.mjs";
import { prepareDevelopmentPublicSite } from "./dev-public-site.mjs";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

// Runs before `pnpm dev`: fills in missing local settings, starts the managed
// PostgreSQL container when this copy owns one, and applies migrations.
try {
  assertNode();
  await prepareEnvironment();
  runPnpm(["run", "db:up"]);
  runPnpm(["run", "db:migrate"]);
  // Manage logins only for this worktree's disposable local database. External
  // deployments supply an already-provisioned application URL themselves.
  if (managesLocalDatabase()) {
    if (
      (process.env.DEPLOYMENT_MODE || "development") === "development" &&
      (process.env.DATA_CLASSIFICATION || "synthetic") === "synthetic"
    ) {
      process.env.MIGRATION_DATABASE_URL ||= process.env.DATABASE_URL;
      runPnpm([
        "--filter",
        "@starter/api",
        "exec",
        "tsx",
        "src/db/seed-dev-tenant.ts",
      ]);
      await prepareDevelopmentPublicSite();
    }
    if (!process.env.APP_DATABASE_URL) {
      const app = new URL(process.env.DATABASE_URL);
      app.username = `legend_runtime_${randomBytes(8).toString("hex")}`;
      app.password = randomBytes(24).toString("hex");
      process.env.APP_DATABASE_URL = app.toString();
      appendFileSync(
        resolve(root, ".env.local"),
        `\nAPP_DATABASE_URL="${app.toString()}"\n`,
        { mode: 0o600 },
      );
    }
    if (!process.env.PAYOUT_GRANTOR_DATABASE_URL) {
      const grantor = new URL(
        process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
      );
      grantor.username = `legend_grant_${randomBytes(8).toString("hex")}`;
      grantor.password = randomBytes(24).toString("hex");
      process.env.PAYOUT_GRANTOR_DATABASE_URL = grantor.toString();
      appendFileSync(
        resolve(root, ".env.local"),
        `\nPAYOUT_GRANTOR_DATABASE_URL="${grantor.toString()}"\n`,
        { mode: 0o600 },
      );
    }
    await provisionRoles({
      adminUrl: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
      appUrl: process.env.APP_DATABASE_URL,
      workerUrl: process.env.WORKER_DATABASE_URL || undefined,
      maintenanceUrl: process.env.MAINTENANCE_DATABASE_URL || undefined,
      grantorUrl: process.env.PAYOUT_GRANTOR_DATABASE_URL,
    });
    console.log(
      "Restricted application and payout grantor database logins provisioned.",
    );
  } else if (!process.env.APP_DATABASE_URL) {
    throw new Error(
      "Set APP_DATABASE_URL to a pre-provisioned restricted application login for an external database.",
    );
  }
} catch (error) {
  console.error(`Setup needs attention: ${error.message}`);
  process.exitCode = 1;
}
