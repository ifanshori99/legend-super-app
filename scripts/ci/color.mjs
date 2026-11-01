import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Temporary starter-template debt. Remove these entries as the design system replaces them.
const legacy = new Map([
  ["apps/web/src/styles/globals.css|#bb371e22", 1],
  ["apps/web/src/components/ui/button.tsx|text-white", 1],
]);
const rawColor =
  /#[\da-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(|\b(?:bg|text|border|ring|outline|fill|stroke|decoration|shadow|accent|caret|from|via|to)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?)(?:\/\d+)?\b|(?<=:\s)["']?(?:white|black|red|blue|green|yellow|orange|purple|pink|gray|grey)\b/gi;

export function findRawColors(file, source) {
  const remaining = new Map(legacy);
  const issues = [];
  for (const [index, line] of source.split("\n").entries()) {
    // Raw values belong in the token declaration stylesheet, not other CSS rules.
    if (
      (file === "apps/web/src/styles/globals.css" ||
        file === "apps/web/src/styles/tokens.css") &&
      /^\s*--[\w-]+\s*:/.test(line)
    )
      continue;
    for (const match of line.matchAll(rawColor)) {
      const key = `${file}|${match[0]}`;
      if ((remaining.get(key) ?? 0) > 0) {
        remaining.set(key, remaining.get(key) - 1);
      } else {
        issues.push({ file, line: index + 1, value: match[0] });
      }
    }
  }
  return issues;
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesIn(name);
      return /\.(?:css|tsx|jsx)$/.test(name) ? [name] : [];
    }),
  );
  return nested.flat();
}

async function main() {
  const files = await filesIn("apps/web/src");
  const issues = (
    await Promise.all(
      files.map(async (file) =>
        findRawColors(file, await readFile(file, "utf8")),
      ),
    )
  ).flat();
  if (issues.length) {
    for (const issue of issues)
      console.error(
        `${issue.file}:${issue.line}: raw color ${issue.value}; use a design token`,
      );
    process.exitCode = 1;
  } else {
    console.log(
      "Design-token color lint passed (2 documented starter-template exceptions).",
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
