// legend-8cf3: the CLI shared by `pnpm db:reset-preswitch-refunds` and
// `node dist/reset-preswitch-refunds.js`. Only paths that stop before any
// database connection: argument errors and missing settings.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cli,
  parseArgs,
  PreswitchResetUsageError,
} from "./reset-preswitch-refund-payouts";

const refundId = "0193a5b0-0000-7000-8000-000000000001";

function idsFile(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), "d21p-ids-")), "ids.txt");
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("legend-8cf3 reset-preswitch-refunds CLI", () => {
  it("parses dry-run and apply options", () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      touchedBefore: undefined,
      ids: undefined,
    });
    const parsed = parseArgs([
      "--apply",
      "--touched-before",
      "2026-11-09T03:00:00Z",
      "--ids",
      idsFile(`# reviewed\n${refundId.toUpperCase()}\n`),
    ]);
    expect(parsed).toEqual({
      apply: true,
      touchedBefore: new Date("2026-11-09T03:00:00Z"),
      ids: [refundId],
    });
  });

  it("refuses bad arguments as usage errors", () => {
    for (const args of [
      ["--bogus"],
      ["--apply"],
      ["--apply", "--dry-run"],
      ["--touched-before"],
      ["--touched-before", "2026-11-09T03:00:00"],
      ["--apply", "--touched-before", "2026-11-09T03:00:00Z"],
      ["--ids", "/nonexistent/d21p-ids.txt"],
    ])
      expect(() => parseArgs(args)).toThrow(PreswitchResetUsageError);
  });

  it("exits 2 with usage on bad arguments, before reading settings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await cli(["--bogus"], { loadEnv: false })).toBe(2);
    expect(await cli(["--apply"], { loadEnv: false })).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1]?.[0])).toMatch(
      /^--apply requires --touched-before\.\nUsage: /,
    );
  });

  it("production mode requires MIGRATION_DATABASE_URL and never prints a URL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MIGRATION_DATABASE_URL", "");
    vi.stubEnv("MIGRATION_DATABASE_URL_FILE", "");
    vi.stubEnv("DATABASE_URL", "postgres://u:secret-pw@db.invalid:5432/app");
    expect(await cli([], { loadEnv: false })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /^MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE is required\./,
    );

    vi.stubEnv(
      "MIGRATION_DATABASE_URL",
      "postgres://u:secret-pw@db.invalid:5432/app",
    );
    vi.stubEnv("MIGRATION_DATABASE_URL_FILE", idsFile("unused"));
    expect(await cli([], { loadEnv: false })).toBe(2);
    expect(String(error.mock.calls[1]?.[0])).toMatch(/not both\./);
    for (const [line] of error.mock.calls)
      expect(String(line)).not.toContain("secret-pw");
  });

  it("production --apply exits 2 when DOIT_REFUNDS_ENABLED is not passed in", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(
      "MIGRATION_DATABASE_URL",
      "postgres://u:secret-pw@db.invalid:5432/app",
    );
    vi.stubEnv("MIGRATION_DATABASE_URL_FILE", "");
    vi.stubEnv("DOIT_REFUNDS_ENABLED", undefined);
    vi.stubEnv("LEGEND_RESET_WRAPPER", "1");
    expect(process.env.DOIT_REFUNDS_ENABLED).toBeUndefined();
    const args = [
      "--apply",
      "--touched-before",
      "2026-11-09T03:00:00Z",
      "--ids",
      idsFile(`${refundId}\n`),
    ];
    expect(await cli(args, { loadEnv: false })).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /^DOIT_REFUNDS_ENABLED is not set, so the switch check is blind\. Run --apply through deploy\/single-vm\/reset-preswitch-refunds\.sh\.\nUsage: /,
    );
    expect(String(error.mock.calls[0]?.[0])).not.toContain("secret-pw");
  });

  it("production --apply exits 2 when not started by the wrapper", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(
      "MIGRATION_DATABASE_URL",
      "postgres://u:secret-pw@db.invalid:5432/app",
    );
    vi.stubEnv("MIGRATION_DATABASE_URL_FILE", "");
    vi.stubEnv("DOIT_REFUNDS_ENABLED", "false");
    const args = [
      "--apply",
      "--touched-before",
      "2026-11-09T03:00:00Z",
      "--ids",
      idsFile(`${refundId}\n`),
    ];
    for (const marker of [undefined, "", "0", "true"]) {
      vi.stubEnv("LEGEND_RESET_WRAPPER", marker);
      expect(await cli(args, { loadEnv: false })).toBe(2);
    }
    expect(error).toHaveBeenCalledTimes(4);
    for (const [line] of error.mock.calls) {
      expect(String(line)).toMatch(
        /^LEGEND_RESET_WRAPPER is not 1, so this --apply did not come through the wrapper/,
      );
      expect(String(line)).not.toContain("secret-pw");
    }
  });
});
