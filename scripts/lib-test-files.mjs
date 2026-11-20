import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Pure helpers for LEGEND_TEST_FILES, kept apart from test.mjs so they can be
// tested without a database. Vitest runs inside apps/api, so API paths must be
// relative to that package ("src/test/x.test.ts"), not to the repo root.
export function normalizeTestFile(file) {
  let path = file;
  while (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("apps/api/")) path = path.slice("apps/api/".length);
  return path;
}

export function normalizeTestFiles(files) {
  return files.map(normalizeTestFile);
}

// Where a normalized path lives on disk: root tests and web tests are relative
// to the repo root, everything else is an API vitest file under apps/api.
export function testFileLocation(file, root) {
  if (file.endsWith(".test.mjs") || file.startsWith("apps/web/test/"))
    return resolve(root, file);
  return resolve(root, "apps/api", file);
}

// Normalized paths that match no file. Flags (-t, --bail) are not paths.
export function findMissingTestFiles(files, root, exists = existsSync) {
  return files.filter(
    (file) => !file.startsWith("-") && !exists(testFileLocation(file, root)),
  );
}
