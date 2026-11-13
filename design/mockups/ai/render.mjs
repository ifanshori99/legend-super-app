import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Run from the repository root: heavy node design/mockups/ai/render.mjs
// Ghostex checks each actual HTML state at both requested widths.
const dir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(dir, "ai-settings.html"), "utf8");
const marker = "const INITIAL_STATE = 'empty';";
if (!source.includes(marker)) throw new Error("Missing initial state marker");
const states = [
  "empty",
  "device",
  "connected",
  "failed",
  "expired",
  "detected",
  "disabled",
  "loading",
  "offline",
  "session",
];
const temporary = path.join(dir, ".ai-settings-render.html");
const results = [];
try {
  for (const state of states) {
    writeFileSync(
      temporary,
      source.replace(marker, `const INITIAL_STATE = '${state}';`),
    );
    for (const [device, width] of [
      ["desktop", 1280],
      ["mobile", 390],
    ]) {
      const output = path.join(dir, `ai-settings-${state}-${device}.png`);
      const args = [
        "visual",
        "check",
        temporary,
        "--width",
        String(width),
        "--out",
        output,
      ];
      const log = execFileSync("ghostex", args, {
        encoding: "utf8",
        maxBuffer: 2 ** 20,
      });
      if (
        /^- Reaches past|^  - Reaches past|could not be embedded|Script error/im.test(
          log,
        )
      )
        throw new Error(log);
      console.log(`${state} ${device}: ${log.trim()}`);
      results.push({
        state,
        device,
        width,
        command: `ghostex ${args.join(" ")}`,
        result: log.trim(),
      });
    }
  }
  writeFileSync(
    path.join(dir, "render-results.json"),
    JSON.stringify({ tool: "ghostex visual check", results }, null, 2) + "\n",
  );
} finally {
  try {
    unlinkSync(temporary);
  } catch {
    /* Already removed */
  }
}
