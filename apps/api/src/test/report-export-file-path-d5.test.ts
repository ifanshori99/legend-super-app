import { describe, expect, it } from "vitest";
import { reportExportFileSchema } from "@starter/shared/dashboard";

const base = {
  sizeBytes: 10,
  rowCount: 1,
  expiresAt: "2026-11-28T00:00:00.000Z",
};

function parsePath(downloadPath: string) {
  return reportExportFileSchema.safeParse({ ...base, downloadPath }).success;
}

describe("1272 D5 report export download path", () => {
  it("accepts the server-built API path", () => {
    expect(
      parsePath(
        "/api/reports/exports/7d0f2c1e-1111-4222-8333-944455556666/file",
      ),
    ).toBe(true);
  });

  it.each([
    "//evil.example/x",
    "/\\evil.example/x",
    "/reports/x",
    "https://evil.example/api/x",
    "/api/reports/x?next=//evil",
  ])("refuses %s", (path) => {
    expect(parsePath(path)).toBe(false);
  });
});
