// Fails when this checkout's installed packages come from another checkout.
//
// Git worktrees under .worktrees/ sit inside the main checkout. A worktree
// without its own `pnpm install`, or with node_modules symlinked to the main
// checkout's, resolves dependencies from the main checkout's virtual store,
// and a build or test can pass without this branch's packages/shared changes
// (legend-meki). Run `pnpm worktree:setup` in the worktree to fix it.
//
// Uses only node: built-ins so it runs before (and without) an install.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const workspacePackages = {
  "apps/web": ["@starter/shared"],
  "apps/api": ["@starter/shared"],
};

const inside = (path) => path === root || path.startsWith(root + sep);
const problems = [];

function checkDir(path) {
  const full = resolve(root, path);
  if (!existsSync(full)) {
    problems.push(`${path} is missing`);
    return false;
  }
  if (lstatSync(full).isSymbolicLink())
    problems.push(`${path} is a symlink to ${realpathSync(full)}`);
  else if (!inside(realpathSync(full)))
    problems.push(`${path} resolves outside this checkout`);
  return true;
}

if (checkDir("node_modules")) checkDir("node_modules/.pnpm");

for (const [app, packages] of Object.entries(workspacePackages)) {
  if (!checkDir(`${app}/node_modules`)) continue;
  for (const name of packages) {
    const link = resolve(root, app, "node_modules", name);
    const expected = resolve(root, "packages", name.split("/")[1]);
    if (!existsSync(link)) {
      problems.push(`${app} cannot find ${name}`);
      continue;
    }
    const actual = realpathSync(link);
    if (actual !== expected)
      problems.push(
        `${app} resolves ${name} to ${actual}, expected ${relative(root, expected)} in this checkout`,
      );
  }
}

if (problems.length) {
  console.error("Workspace links do not belong to this checkout:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "Run `pnpm worktree:setup` (or `node scripts/worktree-setup.mjs`) in this checkout, then try again.",
  );
  process.exit(1);
}
