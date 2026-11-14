import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const apiRoot = fileURLToPath(new URL("../apps/api/", import.meta.url));
const requireApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const vitestNode = pathToFileURL(requireApi.resolve("vitest/node")).href;

for (const maxWorkers of [undefined, "2"]) {
  test(`API files stay serial with a worker cap and VITEST_MAX_WORKERS=${maxWorkers ?? "unset"}`, () => {
    const env = { ...process.env };
    delete env.VITEST_MAX_WORKERS;
    if (maxWorkers !== undefined) env.VITEST_MAX_WORKERS = maxWorkers;
    // Resolve in a fresh process: loading the real config must neutralize the
    // environment cap injected by heavy before Vitest normalizes its options.
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { resolveConfig } from ${JSON.stringify(vitestNode)};
         const config = await resolveConfig({ maxWorkers: 2 });
         console.log(JSON.stringify({
           fileParallelism: config.test.fileParallelism,
           maxWorkers: config.test.maxWorkers,
         }));`,
      ],
      { cwd: apiRoot, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const resolved = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(resolved, { fileParallelism: false, maxWorkers: 1 });
  });
}
