// The migration owner's login for one-off data commands that must never run as
// the app login (legend-1265 G3): backfill-ptkp-history and
// repair-supplier-invoice-npwp. A built run (node dist/<name>.js) needs
// MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE and stops without it
// before any connection; the source run (tsx) keeps the DATABASE_URL fallback
// for local development. Nothing here prints a URL.
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { databaseUrl } from "./connection.ts";

/** Our own message, safe to print; driver errors go through databaseError. */
export class SafeError extends Error {}

/** `built` is true for dist/*.js (the caller passes its import.meta.url test). */
export function migrationOwnerUrl(built: boolean): string {
  const direct = process.env.MIGRATION_DATABASE_URL;
  const file = process.env.MIGRATION_DATABASE_URL_FILE;
  if (direct && file)
    throw new SafeError(
      "Set MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE, not both.",
    );
  if (file) {
    try {
      return databaseUrl(readFileSync(file, "utf8").trim());
    } catch {
      throw new SafeError(
        "Cannot read a valid URL from the file named by MIGRATION_DATABASE_URL_FILE.",
      );
    }
  }
  if (direct) return databaseUrl(direct);
  if (built)
    throw new SafeError(
      "Set MIGRATION_DATABASE_URL (or MIGRATION_DATABASE_URL_FILE): this command must run as the migration owner, not the app login.",
    );
  return databaseUrl(process.env.DATABASE_URL);
}

/** Refuses a login that is neither superuser nor BYPASSRLS, before any write. */
export async function assertMigrationOwner(pool: Pool): Promise<void> {
  const role = await pool.query<{ ok: boolean }>(
    "SELECT rolsuper OR rolbypassrls AS ok FROM pg_catalog.pg_roles WHERE rolname = current_user",
  );
  if (!role.rows[0]?.ok)
    throw new SafeError(
      "The login is not the migration owner (needs superuser or BYPASSRLS); nothing was written.",
    );
}
